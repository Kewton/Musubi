#!/usr/bin/env python3
"""Verify scoped R2 S3 credentials from the ignored root .env without printing them.

Creates, reads and deletes only a uniquely named probe object in musubi-tfstate.
Requires curl with --aws-sigv4 support. Does not create or change Terraform state.
"""

import json
import re
import subprocess
import sys
import uuid
from pathlib import Path


def main():
    env_path = Path(__file__).resolve().parents[4] / ".env"
    values = {}
    for line in env_path.read_text().splitlines():
        match = re.match(r"\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)", line)
        if match:
            values[match[1]] = match[2].strip().strip("\"'")

    account = values.get("CLOUDFLARE_ACCOUNT_ID", "")
    access = values.get("R2_ACCESS_KEY_ID", "")
    secret = values.get("R2_SECRET_ACCESS_KEY", "")
    if not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        raise RuntimeError("CLOUDFLARE_ACCOUNT_ID is missing or invalid")
    if not re.fullmatch(r"[a-fA-F0-9]{32}", access):
        raise RuntimeError("R2_ACCESS_KEY_ID is missing or invalid")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", secret):
        raise RuntimeError("R2_SECRET_ACCESS_KEY is missing or invalid")
    endpoint = f"https://{account}.r2.cloudflarestorage.com"
    if values.get("R2_S3_ENDPOINT") != endpoint:
        raise RuntimeError("R2_S3_ENDPOINT must match the selected Cloudflare account")
    if values.get("TFSTATE_BUCKET") != "musubi-tfstate":
        raise RuntimeError("This bootstrap check only targets musubi-tfstate")

    def request(method, suffix="", payload=None):
        # Secrets travel via stdin, never shell arguments or diagnostic output.
        options = {
            "url": f"{endpoint}/musubi-tfstate{suffix}",
            "user": f"{access}:{secret}",
            "aws-sigv4": "aws:amz:auto:s3",
            "request": method,
        }
        if payload is not None:
            options["data-binary"] = payload
        config = "\n".join(f"{key} = {json.dumps(value)}" for key, value in options.items())
        result = subprocess.run(
            ["curl", "-q", "--silent", "--show-error", "--max-time", "30",
             "--config", "-", "--write-out", "\n%{http_code}"],
            input=config, text=True, capture_output=True, check=False,
        )
        if result.returncode:
            raise RuntimeError(f"{method}: curl failed (exit {result.returncode}); check network access")
        body, _, status = result.stdout.rpartition("\n")
        if status not in {"200", "204"}:
            code = re.search(r"<Code>([A-Za-z0-9._-]{1,80})</Code>", body)
            raise RuntimeError(f"{method}: HTTP {status}, code={code[1] if code else 'unknown'}")
        return body

    request("GET", "?list-type=2&max-keys=1")
    print("PASS: list objects")
    probe = f"/_bootstrap/credential-check-{uuid.uuid4().hex}.txt"
    payload = f"Musubi R2 credential probe {uuid.uuid4().hex}"
    try:
        request("PUT", probe, payload)
        print("PASS: write probe")
        if request("GET", probe) != payload:
            raise RuntimeError("Probe read did not match its original contents")
        print("PASS: read probe contents")
    finally:
        request("DELETE", probe)
        print("PASS: remove probe")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError) as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
