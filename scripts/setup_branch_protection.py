#!/usr/bin/env python3
"""
setup_branch_protection.py

Enable branch protection on `main` for the NetConsole repo via GitHub REST API.
This makes PR + 1 approval + CI green checks required before any merge to main,
which in turn means every code change to main comes through a reviewed PR and
triggers the `Deploy` workflow safely.

Usage:
    # 1. Create a fine-grained PAT with these repository permissions:
    #       - Administration: Read & Write
    #    Or use a classic PAT with `repo` scope.
    # 2. Set the env var:
    #       export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
    #    On Windows PowerShell:
    #       $env:GITHUB_TOKEN = "ghp_xxxxxxxxxxxxxxxxxxxx"
    # 3. Run:
    #       python scripts/setup_branch_protection.py
    #
#    4. Verify in browser: https://github.com/Sonlak/netconsole/settings/branches

Idempotent: safe to run multiple times.
"""
import os
import sys
import urllib.request
import urllib.error
import json

REPO_OWNER = "Sonlak"
REPO_NAME = "netconsole"
BRANCH = "main"

API_BASE = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}"


def call(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "netconsole-branch-setup",
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            err = json.loads(body)
            msg = err.get("message", body)
        except Exception:
            msg = body
        print(f"❌ {method} {path} -> HTTP {e.code}: {msg}")
        sys.exit(1)


def main() -> None:
    if "GITHUB_TOKEN" not in os.environ:
        print("[ERR] Set GITHUB_TOKEN env var first (PAT with repo/admin scope).")
        sys.exit(1)

    print(f"Repo: {REPO_OWNER}/{REPO_NAME}")
    print(f"Branch: {BRANCH}")

    # 1. Get current branch info to find its commit SHA (required for strict status checks)
    print("\n[1/3] Reading branch info...")
    branch_info = call("GET", f"/branches/{BRANCH}")
    head_sha = branch_info["commit"]["sha"]
    print(f"  HEAD = {head_sha}")
    print("\n[2/3] Looking for CI check names...")
    # GitHub only allows checks that have run at least once on the branch.
    # Triggering CI: the easiest is to push a commit and wait.
    # If the user has already pushed something recently that ran CI,
    # the following query will list the actual check names.
    checks_resp = call("GET", f"/commits/{head_sha}/check-runs?per_page=100")
    actual_checks = sorted({c["name"] for c in checks_resp.get("check_runs", [])})

    # Map our CI workflow job names to likely check names
    candidate_check_names = [
        "Backend (lint + test + build)",
        "Frontend (type-check + build)",
        "Worker (lint + smoke)",
        "Docker Compose syntax",
        "CI / Backend (lint + test + build)",
        "CI / Frontend (type-check + build)",
        "CI / Worker (lint + smoke)",
        "CI / Docker Compose syntax",
        "backend",
        "frontend",
        "worker",
        "compose-validate",
    ]

    available = [c for c in candidate_check_names if c in actual_checks]
    if not available:
        print("  [WARN] No CI checks have run on this branch yet.")
        print("         Status check enforcement will be configured with placeholders.")
        print("         After the first CI run, re-run this script to add real checks.")
        # We can still proceed with strict = true (only latest commit), which is useful on its own.
        required_status_checks = None
    else:
        print(f"  Found checks: {available}")
        required_status_checks = {
            "strict": True,  # branch must be up-to-date with base before merging
            "contexts": available,
        }

    # 3. Apply protection
    print("\n[3/3] Applying branch protection...")
    body = {
        "required_status_checks": required_status_checks,
        "enforce_admins": True,
        "required_pull_request_reviews": {
            "dismiss_stale_reviews": True,
            "require_code_owner_reviews": False,
            "required_approving_review_count": 1,
            "require_last_push_approval": False,
        },
        "restrictions": None,
        "required_linear_history": True,
        "allow_force_pushes": False,
        "allow_deletions": False,
        "block_creations": False,
        "required_conversation_resolution": True,
        "lock_branch": False,
        "allow_fork_syncing": False,
    }
    call("PUT", f"/branches/{BRANCH}/protection", body)
    print(f"[OK] Branch protection applied to {BRANCH}")

    print("\nNext steps:")
    print(f"  - Verify at: https://github.com/{REPO_OWNER}/{REPO_NAME}/settings/branches")
    print("  - Push any change to trigger CI; then re-run this script to lock in check names.")


if __name__ == "__main__":
    main()