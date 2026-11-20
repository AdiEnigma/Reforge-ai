"""
cli_process.py — Direct CLI runner for ReForge Vision Engine.
Reads JSON request from stdin, calls process_images, writes JSON to stdout.
Enables reliable direct IPC execution from Node.js without requiring a separate web server.
"""
from __future__ import annotations

import sys
import json
import asyncio
from schemas import ProcessRequest
from vision.pipeline import process_images
from vision.model_registry import registry


async def main():
    sys.stderr.write("CLI main start\n")
    sys.stderr.flush()
    input_file = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != "-" else None
    output_file = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        if input_file:
            with open(input_file, "r", encoding="utf-8") as f:
                raw_input = f.read()
        else:
            raw_input = sys.stdin.read()

        if not raw_input.strip():
            err_res = json.dumps({"status": "unavailable", "warnings": ["Empty input"]})
            if output_file:
                with open(output_file, "w", encoding="utf-8") as f:
                    f.write(err_res)
            else:
                print(err_res)
            return

        data = json.loads(raw_input)
        payload = ProcessRequest(**data)
        registry.initialize()
        response = await process_images(payload.images, payload.reference)
        if hasattr(response, "model_dump"):
            result_dict = response.model_dump()
        else:
            result_dict = response.dict()

        out_str = json.dumps(result_dict)
        if output_file:
            with open(output_file, "w", encoding="utf-8") as f:
                f.write(out_str)
        else:
            print(out_str)
    except Exception as e:
        sys.stderr.write(f"cli_process error: {e}\n")
        err_res = json.dumps(
            {
                "status": "unavailable",
                "images": [],
                "warnings": [f"Direct CLI processing error: {e}"],
            }
        )
        if output_file:
            try:
                with open(output_file, "w", encoding="utf-8") as f:
                    f.write(err_res)
            except Exception:
                pass
        else:
            print(err_res)


if __name__ == "__main__":
    asyncio.run(main())
