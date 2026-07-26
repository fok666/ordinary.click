"""Image processor Lambda.

Triggered by S3 ObjectCreated:* events on keys under `originals/`.
The tag-based data model stores each photo once under a content-hash id:

    Read    s3://BUCKET/originals/<id>.<ext>
    Produce s3://BUCKET/display/<id>.<ext>    (display, max 2048px long edge)
    Produce s3://BUCKET/thumbs/<id>.<ext>     (thumb,   max  400px long edge)

The original is left untouched. EXIF orientation is honoured before resizing,
then dropped (we strip metadata for the public derivatives). GPS coordinates
are extracted before stripping and stored on the photo item. Finally the
photo item is marked `ready` with its intrinsic dimensions.
"""

from __future__ import annotations

import io
import logging
import os
import time
from decimal import Decimal
from urllib.parse import unquote_plus

import boto3
from PIL import Image, ImageOps
from PIL.ExifTags import GPSTAGS, TAGS

LOG = logging.getLogger()
LOG.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

BUCKET = os.environ["IMAGE_BUCKET"]
CATALOG_TABLE = os.environ.get("CATALOG_TABLE", "")
DISPLAY_MAX = int(os.environ.get("DISPLAY_MAX_PX", "2048"))
THUMB_MAX = int(os.environ.get("THUMB_MAX_PX", "400"))
JPEG_QUALITY = int(os.environ.get("JPEG_QUALITY", "85"))

ORIGINALS_PREFIX = "originals/"
DISPLAY_PREFIX = "display/"
THUMBS_PREFIX = "thumbs/"

PHOTO_PK = "PHOTO"

# Pillow format -> (encoder name, content type, save kwargs)
_FORMAT_MAP = {
    "JPEG": ("JPEG", "image/jpeg", {"quality": JPEG_QUALITY, "optimize": True, "progressive": True}),
    "PNG":  ("PNG",  "image/png",  {"optimize": True}),
    "WEBP": ("WEBP", "image/webp", {"quality": JPEG_QUALITY, "method": 6}),
    "GIF":  ("GIF",  "image/gif",  {}),
}

_s3 = boto3.client("s3")
_ddb = boto3.resource("dynamodb").Table(CATALOG_TABLE) if CATALOG_TABLE else None


def _extract_gps(img: Image.Image) -> tuple[float, float] | None:
    """Extract GPS coordinates from EXIF data. Returns (lat, lon) or None."""
    try:
        exif_data = img._getexif()
        if not exif_data:
            return None

        gps_info = {}
        for tag_id, value in exif_data.items():
            tag = TAGS.get(tag_id, tag_id)
            if tag == "GPSInfo":
                for gps_tag_id, gps_value in value.items():
                    gps_tag = GPSTAGS.get(gps_tag_id, gps_tag_id)
                    gps_info[gps_tag] = gps_value
                break

        if not gps_info or "GPSLatitude" not in gps_info or "GPSLongitude" not in gps_info:
            return None

        def _to_degrees(dms) -> float:
            d, m, s = [float(v) for v in dms]
            return d + m / 60.0 + s / 3600.0

        lat = _to_degrees(gps_info["GPSLatitude"])
        if gps_info.get("GPSLatitudeRef", "N") == "S":
            lat = -lat

        lon = _to_degrees(gps_info["GPSLongitude"])
        if gps_info.get("GPSLongitudeRef", "E") == "W":
            lon = -lon

        if -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0:
            return (lat, lon)
        return None
    except Exception:
        LOG.debug("no GPS EXIF in image", exc_info=True)
        return None


def _mark_ready(photo_id: str, ext: str, width: int, height: int,
                gps: tuple[float, float] | None) -> None:
    """Mark the photo item ready and record dimensions (+ GPS if present)."""
    if not _ddb:
        return
    sets = [
        "#ready = :true",
        "width = :w",
        "height = :h",
        "ext = if_not_exists(ext, :ext)",
        "updatedAt = :ts",
    ]
    vals = {
        ":true": True,
        ":w": int(width),
        ":h": int(height),
        ":ext": ext,
        ":ts": int(time.time()),
    }
    if gps:
        sets.append("latitude = if_not_exists(latitude, :lat)")
        sets.append("longitude = if_not_exists(longitude, :lon)")
        vals[":lat"] = Decimal(str(round(gps[0], 6)))
        vals[":lon"] = Decimal(str(round(gps[1], 6)))
    try:
        _ddb.update_item(
            Key={"pk": PHOTO_PK, "sk": photo_id},
            UpdateExpression="SET " + ", ".join(sets),
            ExpressionAttributeNames={"#ready": "ready"},
            ExpressionAttributeValues=vals,
        )
        LOG.info("marked %s ready (%dx%d)%s", photo_id, width, height,
                 " with GPS" if gps else "")
    except Exception:
        LOG.exception("failed to mark %s ready", photo_id)


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
    if "/" in rel or "." not in rel:
        LOG.warning("skipping %s: expected originals/<id>.<ext>", key)
        return
    photo_id, _, ext = rel.rpartition(".")
    if not photo_id or not ext:
        LOG.warning("skipping %s: invalid layout", key)
        return

    LOG.info("processing s3://%s/%s", BUCKET, key)

    obj = _s3.get_object(Bucket=BUCKET, Key=key)
    raw = obj["Body"].read()

    with Image.open(io.BytesIO(raw)) as src:
        src.load()
        gps = _extract_gps(src)
        oriented = ImageOps.exif_transpose(src)
        width, height = oriented.size
        fmt = (src.format or "JPEG").upper()
        if fmt not in _FORMAT_MAP:
            fmt = "JPEG"

        display_img = _resize(oriented, DISPLAY_MAX)
        display_bytes, display_ct = _encode(display_img, fmt)

        thumb_img = _resize(oriented, THUMB_MAX)
        thumb_bytes, thumb_ct = _encode(thumb_img, fmt)

    _s3.put_object(
        Bucket=BUCKET,
        Key=f"{DISPLAY_PREFIX}{rel}",
        Body=display_bytes,
        ContentType=display_ct,
        CacheControl="public, max-age=31536000, immutable",
    )
    _s3.put_object(
        Bucket=BUCKET,
        Key=f"{THUMBS_PREFIX}{rel}",
        Body=thumb_bytes,
        ContentType=thumb_ct,
        CacheControl="public, max-age=31536000, immutable",
    )

    LOG.info("done %s display=%dB thumb=%dB", rel, len(display_bytes), len(thumb_bytes))

    _mark_ready(photo_id, ext, width, height, gps)


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
