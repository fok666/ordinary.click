"""Gallery API Lambda.

Endpoints (all under /api/* via CloudFront):

    GET /api/categories            -> { "categories": [ { "name": "...", "count": N, "cover": "..." }, ... ] }
    GET /api/categories/<name>     -> { "name": "...", "images": [ { "key": "...", "url": "...", "size": N }, ... ] }
    GET /api/health                -> { "status": "ok" }

The S3 image bucket is laid out as:
    categories/<category-name>/<image-file>

Images are returned as URLs under the public site host (CloudFront /images/...),
not as pre-signed S3 URLs, so the browser hits the CDN.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any
from urllib.parse import unquote

import boto3
from botocore.config import Config

LOG = logging.getLogger()
LOG.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

BUCKET = os.environ["IMAGE_BUCKET"]
IMAGE_HOST = os.environ.get("IMAGE_HOST", "").rstrip("/")
PREFIX = "categories/"

_s3 = boto3.client("s3", config=Config(retries={"max_attempts": 3, "mode": "standard"}))


def _response(status: int, body: Any, *, cache_seconds: int = 60) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "cache-control": f"public, max-age={cache_seconds}",
        },
        "body": json.dumps(body, separators=(",", ":")),
    }


def _public_url(key: str) -> str:
    # key looks like "categories/foo/bar.jpg" -> serve as /images/foo/bar.jpg
    rel = key[len(PREFIX):] if key.startswith(PREFIX) else key
    return f"{IMAGE_HOST}/images/{rel}" if IMAGE_HOST else f"/images/{rel}"


def _list_categories() -> list[dict]:
    paginator = _s3.get_paginator("list_objects_v2")
    categories: dict[str, dict] = {}

    for page in paginator.paginate(Bucket=BUCKET, Prefix=PREFIX, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []) or []:
            name = cp["Prefix"][len(PREFIX):].strip("/")
            if name:
                categories[name] = {"name": name, "count": 0, "cover": None}

    for name in list(categories):
        first_key = None
        count = 0
        for page in paginator.paginate(Bucket=BUCKET, Prefix=f"{PREFIX}{name}/"):
            for obj in page.get("Contents", []) or []:
                if obj["Key"].endswith("/"):
                    continue
                count += 1
                if first_key is None:
                    first_key = obj["Key"]
        categories[name]["count"] = count
        categories[name]["cover"] = _public_url(first_key) if first_key else None

    return sorted(categories.values(), key=lambda c: c["name"])


def _list_category(name: str) -> dict | None:
    name = name.strip("/")
    if not name or "/" in name or ".." in name:
        return None

    paginator = _s3.get_paginator("list_objects_v2")
    images: list[dict] = []

    for page in paginator.paginate(Bucket=BUCKET, Prefix=f"{PREFIX}{name}/"):
        for obj in page.get("Contents", []) or []:
            if obj["Key"].endswith("/"):
                continue
            images.append({
                "key": obj["Key"],
                "url": _public_url(obj["Key"]),
                "size": obj["Size"],
            })

    if not images:
        return None

    return {"name": name, "images": images}


def _route(method: str, path: str) -> dict:
    if method != "GET":
        return _response(405, {"error": "method not allowed"})

    parts = [p for p in path.strip("/").split("/") if p]
    # Expected shape: ["api", ...]; CloudFront passes the original path through.
    if parts and parts[0] == "api":
        parts = parts[1:]

    if not parts:
        return _response(404, {"error": "not found"})

    if parts == ["health"]:
        return _response(200, {"status": "ok"}, cache_seconds=0)

    if parts == ["categories"]:
        return _response(200, {"categories": _list_categories()}, cache_seconds=60)

    if len(parts) == 2 and parts[0] == "categories":
        category = unquote(parts[1])
        result = _list_category(category)
        if result is None:
            return _response(404, {"error": "category not found"})
        return _response(200, result, cache_seconds=60)

    return _response(404, {"error": "not found"})


def handler(event: dict, _context) -> dict:
    LOG.debug("event: %s", json.dumps(event)[:1000])

    # Lambda Function URL events use the API Gateway v2 payload shape.
    http = event.get("requestContext", {}).get("http", {})
    method = http.get("method", event.get("httpMethod", "GET"))
    path = event.get("rawPath") or http.get("path") or event.get("path") or "/"

    try:
        return _route(method, path)
    except Exception:
        LOG.exception("unhandled error for %s %s", method, path)
        return _response(500, {"error": "internal error"}, cache_seconds=0)
