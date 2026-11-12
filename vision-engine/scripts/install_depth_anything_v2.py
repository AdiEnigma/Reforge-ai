#!/usr/bin/env python3
"""Install the pinned official Depth Anything V2 source checkout."""
from __future__ import annotations

import subprocess
from pathlib import Path

REPOSITORY_URL = "https://github.com/DepthAnything/Depth-Anything-V2.git"
PINNED_REVISION = "a561b849ebae10a6f5ef49e26c83cbbcd36c71bf"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_PATH = PROJECT_ROOT / ".dependencies" / "Depth-Anything-V2"


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def main() -> None:
    if REPOSITORY_PATH.exists():
        remote = git("-C", str(REPOSITORY_PATH), "remote", "get-url", "origin")
        revision = git("-C", str(REPOSITORY_PATH), "rev-parse", "HEAD")
        if remote != REPOSITORY_URL or revision != PINNED_REVISION:
            raise SystemExit(
                f"Existing path is not the expected official checkout at the pinned revision: {REPOSITORY_PATH}"
            )
        print(f"Official Depth Anything V2 checkout already present at {PINNED_REVISION}")
        return

    REPOSITORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    git("clone", "--filter=blob:none", "--no-checkout", REPOSITORY_URL, str(REPOSITORY_PATH))
    git("-C", str(REPOSITORY_PATH), "checkout", "--detach", PINNED_REVISION)
    revision = git("-C", str(REPOSITORY_PATH), "rev-parse", "HEAD")
    if revision != PINNED_REVISION:
        raise SystemExit(f"Revision mismatch: expected {PINNED_REVISION}, got {revision}")
    print(f"Installed official Depth Anything V2 source at {REPOSITORY_PATH} ({revision})")


if __name__ == "__main__":
    main()
