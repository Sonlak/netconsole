from __future__ import annotations

import logging
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from typing import Any

import httpx

from netconsole_worker.config import settings
from netconsole_worker.models import parse_job
from netconsole_worker.tasks.registry import TASK_REGISTRY

logger = logging.getLogger(__name__)


class WorkerClient:
    def __init__(self) -> None:
        self.base_url = settings.api_base_url.rstrip("/")
        self.client = httpx.Client(timeout=30.0)
        self._headers = self._build_headers()

    def _build_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        token = settings.worker_auth_token
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def close(self) -> None:
        self.client.close()

    def fetch_pending_jobs(self, limit: int = 1) -> list[dict[str, Any]]:
        response = self.client.get(
            f"{self.base_url}/jobs",
            params={"status": "PENDING", "forWorker": "1", "limit": max(1, limit)},
            headers=self._headers,
        )
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, list) else []

    def claim_job(self, job_id: str) -> dict[str, Any]:
        response = self.client.patch(
            f"{self.base_url}/jobs/{job_id}/claim",
            headers=self._headers,
        )
        response.raise_for_status()
        return response.json()

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
        claimed = client.claim_job(job_id)
        result = process_job(claimed)
        client.complete_job(job_id, result=result)
        logger.info("Completed job %s (%s)", job_id, job_type)
    except httpx.HTTPStatusError as exc:
        if exc.response is not None and exc.response.status_code == 409:
            logger.info("Job %s already claimed", job_id)
            return
        logger.exception("Job %s failed", job_id)
        try:
            client.complete_job(job_id, error=str(exc))
        except Exception:
            logger.exception("Could not report failure for job %s", job_id)
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
        level=logging.INFO,
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

    inflight: dict[Future[None], str] = {}
    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="nc-job") as pool:
        while True:
            for fut in [item for item in list(inflight) if item.done()]:
                job_id = inflight.pop(fut)
                try:
                    fut.result()
                except Exception:
                    logger.exception("Job %s worker crash", job_id)

            free = concurrency - len(inflight)
            submitted = 0
            if free > 0:
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
                time.sleep(settings.poll_interval_seconds)
                continue
            if submitted == 0:
                wait(list(inflight), timeout=0.25, return_when=FIRST_COMPLETED)


if __name__ == "__main__":
    main()
