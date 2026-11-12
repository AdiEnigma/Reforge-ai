#!/usr/bin/env python3
"""
download_models.py — Safe checkpoint download script for ReForge AI Vision Engine.

Downloads:
  1. SAM 2.1 Small checkpoint (sam2.1_hiera_small.pt, ~185 MB) - Apache 2.0
  2. Depth Anything V2 Small checkpoint (depth_anything_v2_vits.pth, ~99 MB) - Apache 2.0

Weights are saved to vision-engine/models/ which is excluded from git.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
import urllib.request

MODELS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))

CHECKPOINTS = {
    "sam2.1_small": {
        "filename": "sam2.1_hiera_small.pt",
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
        "description": "SAM 2.1 Small (Hiera) Checkpoint (~185 MB)",
        "license": "Apache-2.0",
        "sha256": "47333a5cf0f23ba5b550dd7eb762b322a30ba5be669b7b9db893444458514930",
    },
    "depth_anything_v2_small": {
        "filename": "depth_anything_v2_vits.pth",
        "url": "https://huggingface.co/depth-anything/Depth-Anything-V2-Small/resolve/main/depth_anything_v2_vits.pth",
        "description": "Depth Anything V2 Small (ViT-S) Checkpoint (~99 MB)",
        "license": "Apache-2.0",
        "sha256": "715fade13be8f229f8a70cc02066f656f2423a59effd0579197bbf57860e1378",
    },
}


def compute_sha256(filepath: str) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def download_file(url: str, dest_path: str, expected_sha256: str | None = None) -> bool:
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)

    if os.path.exists(dest_path):
        print(f"File already exists: {dest_path}")
        if expected_sha256:
            actual = compute_sha256(dest_path)
            if actual == expected_sha256:
                print(f"  Checksum matches: {actual[:16]}... OK")
                return True
            print(f"  Warning: Checksum mismatch for existing file. Re-downloading...")
        else:
            return True

    temp_path = dest_path + ".tmp"
    print(f"Downloading {url} -> {dest_path}")

    try:
        def progress(count, block_size, total_size):
            if total_size > 0:
                percent = int(count * block_size * 100 / total_size)
                mb_downloaded = (count * block_size) / (1024 * 1024)
                mb_total = total_size / (1024 * 1024)
                sys.stdout.write(f"\r  [{percent:3d}%] {mb_downloaded:.1f}/{mb_total:.1f} MB")
                sys.stdout.flush()

        urllib.request.urlretrieve(url, temp_path, reporthook=progress)
        print()

        if expected_sha256:
            actual = compute_sha256(temp_path)
            if actual != expected_sha256:
                print(f"Error: SHA256 mismatch for {dest_path}!")
                print(f"  Expected: {expected_sha256}")
                print(f"  Actual:   {actual}")
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                return False
            print(f"  Verified SHA256: {actual[:16]}... OK")

        os.replace(temp_path, dest_path)
        print(f"Saved: {dest_path}")
        return True

    except Exception as exc:
        print(f"\nDownload error: {exc}")
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return False


def main():
    parser = argparse.ArgumentParser(description="Download ReForge AI Vision model checkpoints.")
    parser.add_argument("--model", choices=["all", "sam2", "depth"], default="all",
                        help="Which checkpoint(s) to download")
    args = parser.parse_args()

    print(f"Target directory: {MODELS_DIR}")
    os.makedirs(MODELS_DIR, exist_ok=True)

    success = True
    targets = []
    if args.model in ("all", "sam2"):
        targets.append(CHECKPOINTS["sam2.1_small"])
    if args.model in ("all", "depth"):
        targets.append(CHECKPOINTS["depth_anything_v2_small"])

    for item in targets:
        dest = os.path.join(MODELS_DIR, item["filename"])
        print(f"\n--- {item['description']} ({item['license']}) ---")
        ok = download_file(item["url"], dest, item["sha256"])
        if not ok:
            success = False

    if success:
        print("\nAll requested checkpoints downloaded and verified successfully.")
    else:
        print("\nOne or more downloads failed. Please check your network connection.")
        sys.exit(1)


if __name__ == "__main__":
    main()

