from __future__ import annotations

import logging
import signal
import threading
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from typing import Any

import httpx

from netconsole_worker.config import settings
from netconsole_worker.junos_rest import get_rest_pool
from netconsole_worker.models import parse_job
from netconsole_worker.ssh_client import get_pool
from netconsole_worker.tasks.registry import TASK_REGISTRY

logger = logging.getLogger(__name__)

# Graceful-shutdown knobs. The container's `stop_grace_period` in
# docker-compose.app.yml caps how long Docker waits before SIGKILL after
# `docker stop`. We drain in-flight jobs up to DRAIN_TIMEOUT_SECS, then exit
# even if work is mid-flight. Stale RUNNING rows are reclaimed by the
# backend's jobWatchdog every 30s, so the worst-case loss is at most ~1
# re-pickup latency for an unlucky Juniper INTERFACE_ACTION. Juniper RESTCONF
# writes can run 60-120s (gotcha #15a); we pick 180s as the drain budget.
# DRAIN_TIMEOUT_SECS MUST be ≤ container stop_grace_period (300s) to avoid
# Docker force-killing us mid-shutdown.
DRAIN_TIMEOUT_SECS = 180


class WorkerClient:
    def __init__(self) -> None:
        self.base_url = settings.api_base_url.rstrip("/")
        self.client = httpx.Client(timeout=30.0)
        self._headers = self._build_headers()
        # Phase 2 (2026-10-14): cache the worker name so fetch_pending_jobs
        # can pass it to /jobs/queue?workName=. The backend stamps the
        # value into Job.claimedBy for debugging stuck-RUNNING jobs.
        self.settings = settings

    def _build_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        token = settings.worker_auth_token
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def close(self) -> None:
        self.client.close()

    def fetch_pending_jobs(self, limit: int = 1) -> list[dict[str, Any]]:
        # Phase 2 (2026-10-14): /jobs/queue now atomically claims inside
        # a SELECT FOR UPDATE SKIP LOCKED transaction (see
        # backend/src/routes/jobs.ts). The response array contains jobs
        # whose status was just flipped PENDING → RUNNING. We pass the
        # worker identity as ?workName= so the backend stamps the
        # claimedBy audit column for debugging stuck-RUNNING jobs.
        response = self.client.get(
            f"{self.base_url}/jobs/queue",
            params={"limit": max(1, limit), "workName": self.settings.worker_name},
            headers=self._headers,
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, list) else []

    def complete_job(
        self,
        job_id: str,
        *,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        response = self.client.patch(
            f"{self.base_url}/jobs/{job_id}/complete",
            json={"result": result, "error": error},
            headers=self._headers,
        )
        response.raise_for_status()
        return response.json()


INTERACTIVE_JOB_TYPES = {
    "INTERFACE_ACTION",
    "APPLY_CONFIG",
    "ROLLBACK_CONFIG",
    "MANAGED_CHECK",
    "CONNECT_TEST",
    "DISCOVERY_PROBE",
}


def pick_next_job(jobs: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not jobs:
        return None

    def sort_key(job: dict[str, Any]) -> tuple[int, str]:
        interactive = 0 if job.get("type") in INTERACTIVE_JOB_TYPES else 1
        return (interactive, str(job.get("createdAt") or ""))

    return min(jobs, key=sort_key)


def process_job(payload: dict[str, Any]) -> dict[str, Any]:
    job = parse_job(payload)
    task = TASK_REGISTRY.get(job.type)
    if not task:
        raise ValueError(f"Unsupported job type: {job.type}")
    return task.run(job, job.device)


def run_job(payload: dict[str, Any]) -> None:
    client = WorkerClient()
    job_id = payload["id"]
    job_type = payload.get("type")
    try:
        # Phase 2 (2026-10-14): no more separate claim call. /jobs/queue
        # atomically flips status PENDING → RUNNING via SELECT FOR UPDATE
        # SKIP LOCKED inside the backend transaction. The job returned in
        # `payload` is already claimed. If we still called PATCH /jobs/{id}
        # /claim here, the backend would return 409 (already RUNNING) and
        # the existing handler would log "already claimed" and skip
        # processing — silently dropping the job.
        result = process_job(payload)
        client.complete_job(job_id, result=result)
        logger.info("Completed job %s (%s)", job_id, job_type)
    except Exception as exc:
        logger.exception("Job %s failed", job_id)
        try:
            client.complete_job(job_id, error=str(exc))
        except Exception:
            logger.exception("Could not report failure for job %s", job_id)
    finally:
        client.close()


def run_once(client: WorkerClient) -> int:
    jobs = client.fetch_pending_jobs(limit=1)
    payload = pick_next_job(jobs)
    if not payload:
        return 0
    run_job(payload)
    return 1


def main() -> None:
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    concurrency = max(1, int(settings.worker_concurrency))
    poller = WorkerClient()
    logger.info(
        "Worker %s started. API=%s concurrency=%s",
        settings.worker_name,
        settings.api_base_url,
        concurrency,
    )

    # ── Graceful shutdown wiring ──────────────────────────────────────────
    # SIGTERM is what Docker sends on `docker stop` (after stop_grace_period).
    # SIGINT is what Ctrl-C sends (dev). Both flip `_shutdown_event`; the
    # main loop checks it on each iteration and stops fetching new jobs
    # once the in-flight set drains. Hard kill (SIGKILL) skips this — the
    # backend's jobWatchdog reclaims stale RUNNING rows every 30s.
    _shutdown_event = threading.Event()

    def _handle_signal(signum: int, _frame: Any) -> None:
        try:
            name = signal.Signals(signum).name
        except ValueError:
            name = str(signum)
        logger.warning("%s received — initiating graceful shutdown", name)
        _shutdown_event.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    inflight: dict[Future[None], str] = {}
    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="nc-job") as pool:
        last_pool_stats_at = 0.0
        while True:
            # Reap completed futures first so inflight shrinks even during drain.
            for fut in [item for item in list(inflight) if item.done()]:
                job_id = inflight.pop(fut)
                try:
                    fut.result()
                except Exception:
                    logger.exception("Job %s worker crash", job_id)

            # Shutdown gate: if SIGTERM was received AND there is no work in
            # flight, exit the main loop. In-flight jobs keep running in the
            # thread pool and are awaited in the drain phase below.
            if _shutdown_event.is_set() and not inflight:
                logger.info("Shutdown gate: no in-flight jobs, exiting main loop")
                break

            now = time.monotonic()
            if now - last_pool_stats_at >= 300:
                stats = get_pool().stats
                if stats["borrows"] > 0:
                    reuse_pct = 100.0 * stats["reuses"] / stats["borrows"]
                    logger.info(
                        "[ssh-pool] borrows=%d opens=%d reuses=%d closes=%d evictions=%d reuse=%.1f%%",
                        stats["borrows"],
                        stats["opens"],
                        stats["reuses"],
                        stats["closes"],
                        stats["evictions"],
                        reuse_pct,
                    )
                rest_stats = get_rest_pool().stats
                if rest_stats["borrows"] > 0:
                    rest_reuse_pct = 100.0 * rest_stats["reuses"] / rest_stats["borrows"]
                    logger.info(
                        "[rest-pool] borrows=%d opens=%d reuses=%d closes=%d evictions=%d reuse=%.1f%%",
                        rest_stats["borrows"],
                        rest_stats["opens"],
                        rest_stats["reuses"],
                        rest_stats["closes"],
                        rest_stats["evictions"],
                        rest_reuse_pct,
                    )
                last_pool_stats_at = now

            free = concurrency - len(inflight)
            submitted = 0
            if free > 0 and not _shutdown_event.is_set():
                try:
                    jobs = poller.fetch_pending_jobs(limit=free)
                except Exception:
                    logger.exception("Poll pending jobs failed")
                    time.sleep(settings.poll_interval_seconds)
                    continue
                busy = set(inflight.values())
                for payload in jobs:
                    job_id = str(payload.get("id") or "")
                    if not job_id or job_id in busy:
                        continue
                    fut = pool.submit(run_job, payload)
                    inflight[fut] = job_id
                    busy.add(job_id)
                    submitted += 1
                    if len(inflight) >= concurrency:
                        break

            if not inflight:
                if _shutdown_event.is_set():
                    # No work, already logged "exiting main loop" above.
                    break
                time.sleep(settings.poll_interval_seconds)
                continue
            if submitted == 0:
                # While shutting down we wait longer per iteration so the
                # in-flight set has time to drain. Otherwise we wake up
                # every 0.25s and re-check, which just adds log noise.
                wait_timeout = 5.0 if _shutdown_event.is_set() else 0.25
                wait(list(inflight), timeout=wait_timeout, return_when=FIRST_COMPLETED)

        # ── Drain phase ───────────────────────────────────────────────────
        # Main loop exited (either via shutdown + empty inflight, or we
        # broke through the shutdown gate above). If anything is still
        # running we wait up to DRAIN_TIMEOUT_SECS for it to finish. The
        # container's stop_grace_period (300s) gives us 180s of grace
        # before Docker SIGKILLs the process — any jobs that exceed the
        # drain budget are reclaimed by the backend jobWatchdog after 30s.
        if inflight:
            logger.warning(
                "Draining %d in-flight job(s) before exit (timeout=%ds)...",
                len(inflight),
                DRAIN_TIMEOUT_SECS,
            )
            deadline = time.monotonic() + DRAIN_TIMEOUT_SECS
            while inflight and time.monotonic() < deadline:
                wait(list(inflight.keys()), timeout=1.0, return_when=FIRST_COMPLETED)
                for fut in [f for f in inflight if f.done()]:
                    job_id = inflight.pop(fut)
                    try:
                        fut.result()
                    except Exception:
                        logger.exception("Job %s drain crash", job_id)
            if inflight:
                logger.error(
                    "Drain timeout — %d job(s) still running, exiting. "
                    "Backend jobWatchdog will reclaim them within 30s.",
                    len(inflight),
                )
            else:
                logger.info("Drain complete — all in-flight jobs finished cleanly")

        # Tell the pool to stop accepting new work; existing threads keep
        # running because we set wait=False. They are bounded by the
        # drain loop above.
        pool.shutdown(wait=False)

    poller.close()
    logger.info("Worker exited cleanly")


if __name__ == "__main__":
    main()
