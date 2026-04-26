"""Gallery API Lambda.

Public endpoints (cached at CloudFront):

    GET    /api/health                              -> { "status": "ok" }
    GET    /api/config                              -> Cognito client config for the SPA
    GET    /api/categories                          -> { "categories": [...] }
    GET    /api/categories/<name>                   -> { "name": "...", "images": [...] }

Admin endpoints (require a valid Cognito JWT — enforced by API Gateway):

    POST   /api/admin/categories/<name>/uploads     -> presigned POST for direct S3 upload
    DELETE /api/admin/categories/<name>/images/<file>

S3 layout:

    originals/<category>/<file>     # uploaded original (private, kept forever)
    categories/<category>/<file>    # display image, max 2048px on the long edge
    thumbs/<category>/<file>        # thumbnail, max 400px on the long edge

Display + thumbnail derivatives are produced asynchronously by the processor
Lambda when an object is created under `originals/`.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from typing import Any
from urllib.parse import unquote

import boto3
from botocore.config import Config

LOG = logging.getLogger()
LOG.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

BUCKET = os.environ["IMAGE_BUCKET"]
IMAGE_HOST = os.environ.get("IMAGE_HOST", "").rstrip("/")

COGNITO_DOMAIN = os.environ.get("COGNITO_DOMAIN", "")
COGNITO_CLIENT_ID = os.environ.get("COGNITO_CLIENT_ID", "")
COGNITO_REGION = os.environ.get("COGNITO_REGION", "")
SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")

CATEGORIES_PREFIX = "categories/"
ORIGINALS_PREFIX = "originals/"
THUMBS_PREFIX = "thumbs/"

ALLOWED_CONTENT_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
}
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MiB
PRESIGN_EXPIRES_SECONDS = 600

_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$")
_FILE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9 _.()-]{0,127}\.[a-zA-Z0-9]{1,8}$")

_s3 = boto3.client(
    "s3",
    config=Config(retries={"max_attempts": 3, "mode": "standard"}, signature_version="s3v4"),
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _response(status: int, body: Any, *, cache_seconds: int = 0) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "cache-control": f"public, max-age={cache_seconds}" if cache_seconds else "no-store",
        },
        "body": json.dumps(body, separators=(",", ":")),
    }


def _public_url(prefix: str, rel: str) -> str:
    base = IMAGE_HOST or ""
    return f"{base}/{prefix}{rel}"


def _display_url(category: str, filename: str) -> str:
    return _public_url("images/", f"{category}/{filename}")


def _thumb_url(category: str, filename: str) -> str:
    return _public_url("thumbs/", f"{category}/{filename}")


def _safe_name(name: str) -> str | None:
    name = (name or "").strip()
    if not name or not _NAME_RE.match(name):
        return None
    return name


def _safe_filename(name: str) -> str | None:
    name = (name or "").strip()
    if not name or ".." in name or not _FILE_RE.match(name):
        return None
    return name


# ---------------------------------------------------------------------------
# Public reads
# ---------------------------------------------------------------------------

def _list_categories() -> list[dict]:
    paginator = _s3.get_paginator("list_objects_v2")
    categories: dict[str, dict] = {}

    for page in paginator.paginate(Bucket=BUCKET, Prefix=CATEGORIES_PREFIX, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []) or []:
            name = cp["Prefix"][len(CATEGORIES_PREFIX):].strip("/")
            if name:
                categories[name] = {"name": name, "count": 0, "cover": None}

    for name in list(categories):
        first_file = None
        count = 0
        for page in paginator.paginate(Bucket=BUCKET, Prefix=f"{CATEGORIES_PREFIX}{name}/", Delimiter="/"):
            for obj in page.get("Contents", []) or []:
                key = obj["Key"]
                if key.endswith("/"):
                    continue
                rel = key[len(CATEGORIES_PREFIX) + len(name) + 1:]
                if "/" in rel:
                    continue
                count += 1
                if first_file is None:
                    first_file = rel
        categories[name]["count"] = count
        if first_file:
            categories[name]["cover"] = _thumb_url(name, first_file)
            categories[name]["coverFallback"] = _display_url(name, first_file)

    return sorted(categories.values(), key=lambda c: c["name"])


def _list_category(name: str) -> dict | None:
    safe = _safe_name(name)
    if not safe:
        return None
    name = safe

    paginator = _s3.get_paginator("list_objects_v2")
    images: list[dict] = []

    for page in paginator.paginate(Bucket=BUCKET, Prefix=f"{CATEGORIES_PREFIX}{name}/", Delimiter="/"):
        for obj in page.get("Contents", []) or []:
            key = obj["Key"]
            if key.endswith("/"):
                continue
            rel = key[len(CATEGORIES_PREFIX) + len(name) + 1:]
            if "/" in rel:
                continue
            images.append({
                "filename": rel,
                "url": _display_url(name, rel),
                "thumb": _thumb_url(name, rel),
                "size": obj["Size"],
            })

    images.sort(key=lambda i: i["filename"])
    return {"name": name, "images": images}


def _config() -> dict:
    return {
        "cognito": {
            "domain": COGNITO_DOMAIN,
            "clientId": COGNITO_CLIENT_ID,
            "region": COGNITO_REGION,
            "redirectUri": f"{SITE_URL}/" if SITE_URL else "/",
            "logoutUri": f"{SITE_URL}/" if SITE_URL else "/",
        }
    }


# ---------------------------------------------------------------------------
# Admin writes
# ---------------------------------------------------------------------------

def _presign_upload(category: str, body: dict) -> dict:
    safe_cat = _safe_name(category)
    if not safe_cat:
        return _response(400, {"error": "invalid category"})

    safe_file = _safe_filename(body.get("filename", ""))
    if not safe_file:
        return _response(400, {"error": "invalid filename"})

    content_type = (body.get("contentType") or "").lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        return _response(400, {"error": "unsupported content type"})

    key = f"{ORIGINALS_PREFIX}{safe_cat}/{safe_file}"

    post = _s3.generate_presigned_post(
        Bucket=BUCKET,
        Key=key,
        Fields={"Content-Type": content_type},
        Conditions=[
            {"Content-Type": content_type},
            ["content-length-range", 1, MAX_UPLOAD_BYTES],
        ],
        ExpiresIn=PRESIGN_EXPIRES_SECONDS,
    )
    return _response(200, {
        "url": post["url"],
        "fields": post["fields"],
        "key": key,
        "category": safe_cat,
        "filename": safe_file,
    })


def _delete_image(category: str, filename: str) -> dict:
    safe_cat = _safe_name(category)
    safe_file = _safe_filename(filename or "")
    if not safe_cat or not safe_file:
        return _response(400, {"error": "invalid category or filename"})

    keys = [
        f"{ORIGINALS_PREFIX}{safe_cat}/{safe_file}",
        f"{CATEGORIES_PREFIX}{safe_cat}/{safe_file}",
        f"{THUMBS_PREFIX}{safe_cat}/{safe_file}",
    ]
    _s3.delete_objects(
        Bucket=BUCKET,
        Delete={"Objects": [{"Key": k} for k in keys], "Quiet": True},
    )
    return _response(200, {"deleted": safe_file})


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

def _route(method: str, path: str, body: dict | None) -> dict:
    parts = [p for p in path.strip("/").split("/") if p]
    if parts and parts[0] == "api":
        parts = parts[1:]

    if not parts:
        return _response(404, {"error": "not found"})

    if method in ("GET", "HEAD"):
        if parts == ["health"]:
            return _response(200, {"status": "ok"})
        if parts == ["config"]:
            return _response(200, _config(), cache_seconds=300)
        if parts == ["categories"]:
            return _response(200, {"categories": _list_categories()}, cache_seconds=60)
        if len(parts) == 2 and parts[0] == "categories":
            cat = unquote(parts[1])
            result = _list_category(cat)
            if result is None:
                return _response(404, {"error": "category not found"})
            return _response(200, result, cache_seconds=60)
        return _response(404, {"error": "not found"})

    # Admin writes — API Gateway has already validated the JWT before we get here.
    if parts and parts[0] == "admin":
        admin = parts[1:]
        # POST /admin/categories/<name>/uploads
        if method == "POST" and len(admin) == 3 and admin[0] == "categories" and admin[2] == "uploads":
            return _presign_upload(unquote(admin[1]), body or {})
        # DELETE /admin/categories/<name>/images/<filename>
        if method == "DELETE" and len(admin) == 4 and admin[0] == "categories" and admin[2] == "images":
            return _delete_image(unquote(admin[1]), unquote(admin[3]))
        return _response(404, {"error": "not found"})

    if method == "OPTIONS":
        return _response(204, {})
    return _response(405, {"error": "method not allowed"})


def _parse_body(event: dict) -> dict | None:
    raw = event.get("body")
    if not raw:
        return {}
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except Exception:
            return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def handler(event: dict, _context) -> dict:
    LOG.debug("event: %s", json.dumps(event)[:1000])

    http = event.get("requestContext", {}).get("http", {})
    method = http.get("method", event.get("httpMethod", "GET"))
    path = event.get("rawPath") or http.get("path") or event.get("path") or "/"

    body = _parse_body(event)
    if body is None:
        return _response(400, {"error": "invalid json body"})

    try:
        return _route(method, path, body)
    except Exception:
        LOG.exception("unhandled error for %s %s", method, path)
        return _response(500, {"error": "internal error"})
