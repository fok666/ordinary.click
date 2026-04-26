"""Image processor Lambda.

Triggered by S3 ObjectCreated:* events on keys under `originals/`.
For each event:

    Read    s3://BUCKET/originals/<category>/<file>
    Produce s3://BUCKET/categories/<category>/<file>   (display, max 2048px long edge)
    Produce s3://BUCKET/thumbs/<category>/<file>       (thumb,   max  400px long edge)

The original is left untouched. EXIF orientation is honoured before resizing,
then dropped (we strip metadata for the public derivatives).
"""

from __future__ import annotations

import io
import logging
import os
from urllib.parse import unquote_plus

import boto3
from PIL import Image, ImageOps

LOG = logging.getLogger()
LOG.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

BUCKET = os.environ["IMAGE_BUCKET"]
DISPLAY_MAX = int(os.environ.get("DISPLAY_MAX_PX", "2048"))
THUMB_MAX = int(os.environ.get("THUMB_MAX_PX", "400"))
JPEG_QUALITY = int(os.environ.get("JPEG_QUALITY", "85"))

ORIGINALS_PREFIX = "originals/"
CATEGORIES_PREFIX = "categories/"
THUMBS_PREFIX = "thumbs/"

# Pillow format -> (encoder name, content type, save kwargs)
_FORMAT_MAP = {
    "JPEG": ("JPEG", "image/jpeg", {"quality": JPEG_QUALITY, "optimize": True, "progressive": True}),
    "PNG":  ("PNG",  "image/png",  {"optimize": True}),
    "WEBP": ("WEBP", "image/webp", {"quality": JPEG_QUALITY, "method": 6}),
    "GIF":  ("GIF",  "image/gif",  {}),
}

_s3 = boto3.client("s3")


def _resize(img: Image.Image, max_edge: int) -> Image.Image:
    w, h = img.size
    if max(w, h) <= max_edge:
        return img.copy()
    img = img.copy()
    img.thumbnail((max_edge, max_edge), Image.LANCZOS)
    return img


def _encode(img: Image.Image, fmt: str) -> tuple[bytes, str]:
    encoder, content_type, kwargs = _FORMAT_MAP.get(fmt, _FORMAT_MAP["JPEG"])
    out = io.BytesIO()

    if encoder == "JPEG" and img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    elif encoder == "PNG" and img.mode not in ("RGB", "RGBA", "L", "LA", "P"):
        img = img.convert("RGBA")

    img.save(out, format=encoder, **kwargs)
    return out.getvalue(), content_type


def _process_one(key: str) -> None:
    if not key.startswith(ORIGINALS_PREFIX):
        LOG.info("ignoring %s (not under %s)", key, ORIGINALS_PREFIX)
        return

    rel = key[len(ORIGINALS_PREFIX):]
    if "/" not in rel:
        LOG.warning("skipping %s: expected originals/<category>/<file>", key)
        return
    category, _, filename = rel.partition("/")
    if not category or not filename or "/" in filename:
        LOG.warning("skipping %s: invalid layout", key)
        return

    LOG.info("processing s3://%s/%s", BUCKET, key)

    obj = _s3.get_object(Bucket=BUCKET, Key=key)
    raw = obj["Body"].read()

    with Image.open(io.BytesIO(raw)) as src:
        src.load()
        # Honour EXIF orientation before resizing.
        oriented = ImageOps.exif_transpose(src)
        fmt = (src.format or "JPEG").upper()
        if fmt not in _FORMAT_MAP:
            fmt = "JPEG"

        display_img = _resize(oriented, DISPLAY_MAX)
        display_bytes, display_ct = _encode(display_img, fmt)

        thumb_img = _resize(oriented, THUMB_MAX)
        thumb_bytes, thumb_ct = _encode(thumb_img, fmt)

    _s3.put_object(
        Bucket=BUCKET,
        Key=f"{CATEGORIES_PREFIX}{category}/{filename}",
        Body=display_bytes,
        ContentType=display_ct,
        CacheControl="public, max-age=31536000, immutable",
    )
    _s3.put_object(
        Bucket=BUCKET,
        Key=f"{THUMBS_PREFIX}{category}/{filename}",
        Body=thumb_bytes,
        ContentType=thumb_ct,
        CacheControl="public, max-age=31536000, immutable",
    )

    LOG.info(
        "done %s/%s display=%dB thumb=%dB",
        category, filename, len(display_bytes), len(thumb_bytes),
    )


def handler(event: dict, _context) -> dict:
    records = event.get("Records") or []
    processed = 0
    failures: list[str] = []
    for r in records:
        try:
            key = unquote_plus(r["s3"]["object"]["key"])
            _process_one(key)
            processed += 1
        except Exception as exc:  # noqa: BLE001
            LOG.exception("failed to process record")
            failures.append(str(exc))
    return {"processed": processed, "failures": failures}
