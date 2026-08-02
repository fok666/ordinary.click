"""Gallery API Lambda.

Tag-based data model. A photo is stored *once* and can carry any number of
overlapping tags and optionally one curated collection. A photo's effective
tags are the union of its stored tag set and any #hashtags in its
description. All membership + metadata lives in one DynamoDB table; S3 only
stores the image bytes.

ponytail: the DynamoDB attribute and the JSON wire field are still named
`categories` — renaming them means a data migration for zero user-visible
gain. Everything above the wire says "tags".

Public endpoints (cached at CloudFront):

    GET    /api/health                        -> { "status": "ok" }
    GET    /api/config                        -> Cognito client config for the SPA
    GET    /api/catalog                        -> { tags, collections, totals }
    GET    /api/tags                          -> { "tags": [...] }
    GET    /api/tags/<name>                   -> { "name": ..., "images": [...] }
    GET    /api/collections                   -> { "collections": [...] }
    GET    /api/collections/<id>              -> { "id", "title", "images": [...] }
    GET    /api/geo                            -> { "images": [...] }  (all geo-tagged)

`categories` is accepted as a path alias for `tags` so old links keep working.

Admin endpoints (require a valid Cognito JWT — enforced by API Gateway *and*
re-checked here, see `_jwt_claims`):

    POST   /api/admin/uploads                 -> presigned POST for direct S3 upload
    PUT    /api/admin/photos/<id>             -> update photo metadata
    DELETE /api/admin/photos/<id>             -> delete a photo (all derivatives + item)
    POST   /api/admin/collections             -> create a collection
    PUT    /api/admin/collections/<id>        -> update a collection
    DELETE /api/admin/collections/<id>        -> delete a collection (unlinks photos)
    PUT    /api/admin/tags/<name>             -> rename a stored tag across all photos
    DELETE /api/admin/tags/<name>             -> remove a stored tag from all photos

DynamoDB layout (single table):

    Photo      pk="PHOTO"        sk=<id>            (id = sha256 hex of the bytes)
    Collection pk="COLLECTION"   sk=<collectionId>

S3 layout:

    originals/<id>.<ext>    # uploaded original (private, kept forever)
    display/<id>.<ext>      # display image, max 2048px on the long edge
    thumbs/<id>.<ext>       # thumbnail, max 400px on the long edge

Display + thumbnail derivatives are produced asynchronously by the processor
Lambda when an object is created under `originals/`.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
import unicodedata
import uuid
from decimal import Decimal
from typing import Any
from urllib.parse import unquote

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config

LOG = logging.getLogger()
LOG.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

BUCKET = os.environ["IMAGE_BUCKET"]
CATALOG_TABLE = os.environ.get("CATALOG_TABLE", "")
IMAGE_HOST = os.environ.get("IMAGE_HOST", "").rstrip("/")

COGNITO_DOMAIN = os.environ.get("COGNITO_DOMAIN", "")
COGNITO_CLIENT_ID = os.environ.get("COGNITO_CLIENT_ID", "")
COGNITO_REGION = os.environ.get("COGNITO_REGION", "")
SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")

ORIGINALS_PREFIX = "originals/"
DISPLAY_PREFIX = "display/"
THUMBS_PREFIX = "thumbs/"

PHOTO_PK = "PHOTO"
COLLECTION_PK = "COLLECTION"

# content-type -> canonical file extension used for the stored object.
CONTENT_TYPE_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
}
ALLOWED_CONTENT_TYPES = set(CONTENT_TYPE_EXT)

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MiB
PRESIGN_EXPIRES_SECONDS = 600
MAX_TAGS_PER_PHOTO = 25
MAX_DESCRIPTION_LEN = 2000

# [^\W_] = Unicode alnum (so "ü"/"ö" work); \w adds underscore.
_NAME_RE = re.compile(r"^[^\W_][\w .-]{0,63}$")
# "#cars" in a description tags the photo "cars". No spaces, must end on an
# alnum so sentence punctuation ("#cars.") stays out; the lookbehind keeps
# "&#39;"-style entities and infix hashes ("foo#bar") from matching.
_HASHTAG_RE = re.compile(r"(?<![&\w])#([^\W_](?:[\w.-]*[^\W_])?)")
_HASH_RE = re.compile(r"^[a-f0-9]{64}$")
_COLLECTION_ID_RE = re.compile(r"^[a-f0-9]{8,32}$")

_s3 = boto3.client(
    "s3",
    config=Config(retries={"max_attempts": 3, "mode": "standard"}, signature_version="s3v4"),
)
_ddb = boto3.resource("dynamodb").Table(CATALOG_TABLE) if CATALOG_TABLE else None


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _response(status: int, body: Any, *, cache_seconds: int = 0) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "cache-control": f"public, max-age={cache_seconds}" if cache_seconds else "no-store",
            # Static, never reflected from the request: the CloudFront cache key
            # for /api/* excludes headers, so a reflected Origin would poison it.
            "access-control-allow-origin": SITE_URL or "*",
            "access-control-allow-headers": "content-type, authorization",
            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
        },
        "body": json.dumps(body, separators=(",", ":")),
    }


def _public_url(prefix: str, obj: str) -> str:
    base = IMAGE_HOST or ""
    return f"{base}/{prefix}{obj}"


def _display_url(obj: str) -> str:
    # /images/* is rewritten to the display/ prefix at the CloudFront edge.
    return _public_url("images/", obj)


def _thumb_url(obj: str) -> str:
    return _public_url("thumbs/", obj)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _fold(name: str) -> str:
    """Comparison key for tag names: casefold + strip accents, so "ISS"/"iss"
    and "münchen"/"munchen" count as the same tag. Display keeps the original."""
    return "".join(c for c in unicodedata.normalize("NFKD", name.casefold())
                   if not unicodedata.combining(c))


def _safe_name(name: str) -> str | None:
    name = unicodedata.normalize("NFC", (name or "").strip())
    if not name or not _NAME_RE.match(name):
        return None
    return name


def _safe_collection_id(cid: Any) -> str | None:
    cid = str(cid or "").strip().lower()
    if not cid or not _COLLECTION_ID_RE.match(cid):
        return None
    return cid


def _safe_coordinate(val: Any) -> float | None:
    if val is None or val == "":
        return None
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    if not (-180.0 <= f <= 180.0):
        return None
    return f


def _clean_tags(raw: Any) -> list[str]:
    """Validate + de-duplicate a list of tag names (order preserved)."""
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in raw:
        name = _safe_name(item if isinstance(item, str) else "")
        if name and _fold(name) not in seen:
            seen.add(_fold(name))
            out.append(name)
        if len(out) >= MAX_TAGS_PER_PHOTO:
            break
    return out


def _clean_description(raw: Any) -> str | None:
    if raw is None:
        return None
    # NFC so decomposed umlauts don't split #hashtags mid-character.
    return unicodedata.normalize("NFC", str(raw))[:MAX_DESCRIPTION_LEN]


# ---------------------------------------------------------------------------
# DynamoDB reads
# ---------------------------------------------------------------------------

def _query_all(pk: str) -> list[dict]:
    if not _ddb:
        return []
    items: list[dict] = []
    kwargs: dict[str, Any] = {"KeyConditionExpression": Key("pk").eq(pk)}
    while True:
        resp = _ddb.query(**kwargs)
        items.extend(resp.get("Items", []))
        lek = resp.get("LastEvaluatedKey")
        if not lek:
            break
        kwargs["ExclusiveStartKey"] = lek
    return items


def _all_photos() -> list[dict]:
    return _query_all(PHOTO_PK)


def _all_collections() -> list[dict]:
    return _query_all(COLLECTION_PK)


def _photo_key(item: dict) -> str:
    return f"{item['sk']}.{item.get('ext', 'jpg')}"


def _photo_tags(item: dict) -> set[str]:
    """Effective tags: the stored set plus #hashtags found in the description."""
    tags = set(item.get("categories", set()))
    keys = {_fold(t) for t in tags}
    for t in _HASHTAG_RE.findall(str(item.get("description") or "")):
        # Stored spelling wins over a fold-equal hashtag variant.
        if _NAME_RE.match(t) and _fold(t) not in keys:
            keys.add(_fold(t))
            tags.add(t)
    return tags


def _photo_public(item: dict) -> dict:
    obj = _photo_key(item)
    out: dict[str, Any] = {
        "id": item["sk"],
        "filename": item.get("filename", obj),
        "url": _display_url(obj),
        "thumb": _thumb_url(obj),
        # `categories` is the stored, editable set; `tags` adds description hashtags.
        "categories": sorted(item.get("categories", set())),
        "tags": sorted(_photo_tags(item)),
        "ready": bool(item.get("ready", False)),
    }
    desc = item.get("description")
    if desc:
        out["description"] = str(desc)
    if "latitude" in item and "longitude" in item:
        out["latitude"] = float(item["latitude"])
        out["longitude"] = float(item["longitude"])
    if item.get("collectionId"):
        out["collectionId"] = item["collectionId"]
        if "collectionOrder" in item:
            out["collectionOrder"] = int(item["collectionOrder"])
    if "width" in item and "height" in item:
        out["width"] = int(item["width"])
        out["height"] = int(item["height"])
    return out


def _tags_from(photos: list[dict]) -> list[dict]:
    cats: dict[str, dict] = {}
    photo_keys: list[set[str]] = []  # each ready photo's tag fold keys
    for p in photos:
        if not p.get("ready"):
            continue
        obj = _photo_key(p)
        keys: set[str] = set()
        for name in _photo_tags(p):
            # Grouped by fold key so spelling variants collapse into one
            # entry; the first-seen spelling is the display name.
            k = _fold(name)
            keys.add(k)
            entry = cats.setdefault(k, {"name": name, "count": 0, "_cover": None})
            entry["count"] += 1
            if entry["_cover"] is None:
                entry["_cover"] = obj
        if keys:
            photo_keys.append(keys)
    # A single-photo tag is clutter when that photo is reachable through its
    # other tags: mark it hidden (public Tags page filters, admins see all).
    hidden = {k for keys in photo_keys if len(keys) > 1
              for k in keys if cats[k]["count"] == 1}
    # ...but never orphan a photo: if ALL its tags got hidden, un-hide the
    # alphabetically first one. Safe: a hidden tag belongs to one photo only.
    for keys in photo_keys:
        if keys <= hidden:
            hidden.discard(min(keys, key=lambda k: cats[k]["name"].lower()))
    result = []
    for k, e in sorted(cats.items(), key=lambda kv: kv[1]["name"].lower()):
        cover = e["_cover"]
        result.append({
            "name": e["name"],
            "count": e["count"],
            "cover": _thumb_url(cover) if cover else None,
            "coverFallback": _display_url(cover) if cover else None,
            **({"hidden": True} if k in hidden else {}),
        })
    return result


def _collections_from(photos: list[dict], coll_items: list[dict]) -> list[dict]:
    members: dict[str, list[tuple]] = {}
    for p in photos:
        cid = p.get("collectionId")
        if not cid:
            continue
        members.setdefault(cid, []).append((
            int(p.get("collectionOrder", 0)),
            p["sk"],
            _photo_key(p),
            bool(p.get("ready")),
        ))
    result = []
    for c in coll_items:
        cid = c["sk"]
        mem = sorted(members.get(cid, []))
        ready_mem = [m for m in mem if m[3]]
        cover = None
        cover_id = c.get("coverPhotoId")
        if cover_id:
            cover = next((m[2] for m in mem if m[1] == cover_id), None)
        if not cover and ready_mem:
            cover = ready_mem[0][2]
        result.append({
            "id": cid,
            "title": str(c.get("title", cid)),
            "description": str(c.get("description", "")) or None,
            "count": len(ready_mem),
            "cover": _thumb_url(cover) if cover else None,
            "coverFallback": _display_url(cover) if cover else None,
        })
    result.sort(key=lambda x: x["title"].lower())
    return result


def _catalog() -> dict:
    photos = _all_photos()
    colls = _all_collections()
    tags = _tags_from(photos)
    collections = _collections_from(photos, colls)
    ready = sum(1 for p in photos if p.get("ready"))
    return {
        "tags": tags,
        "categories": tags,  # ponytail: legacy alias for cached clients, drop later
        "collections": collections,
        "totals": {
            "photos": ready,
            "tags": len(tags),
            "categories": len(tags),  # ponytail: legacy alias, drop later
            "collections": len(collections),
        },
    }


def _list_tag(name: str) -> dict | None:
    safe = _safe_name(name)
    if not safe:
        return None
    key = _fold(safe)
    photos = _all_photos()
    matched = [p for p in photos if key in {_fold(t) for t in _photo_tags(p)}]
    if not matched:
        return None
    imgs = [_photo_public(p) for p in matched]
    # ready photos first (by id), pending ones last.
    imgs.sort(key=lambda i: (not i["ready"], i["id"]))
    return {"name": safe, "images": imgs}


def _collection_detail(cid: str) -> dict | None:
    safe = _safe_collection_id(cid)
    if not safe or not _ddb:
        return None
    citem = _ddb.get_item(Key={"pk": COLLECTION_PK, "sk": safe}).get("Item")
    if not citem:
        return None
    photos = _all_photos()
    mem = [p for p in photos if p.get("collectionId") == safe]
    mem.sort(key=lambda p: (not p.get("ready"), int(p.get("collectionOrder", 0)), p["sk"]))
    return {
        "id": safe,
        "title": str(citem.get("title", safe)),
        "description": str(citem.get("description", "")) or None,
        "images": [_photo_public(p) for p in mem],
    }


def _list_geotagged() -> list[dict]:
    photos = _all_photos()
    out = []
    for p in photos:
        if not p.get("ready") or "latitude" not in p or "longitude" not in p:
            continue
        pub = _photo_public(p)
        out.append(pub)
    return out


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
# DynamoDB writes
# ---------------------------------------------------------------------------

def _upsert_photo_on_upload(hash_: str, ext: str, filename: str, content_type: str,
                            categories: list[str], collection_id: str | None,
                            description: str | None, lat: float | None, lng: float | None) -> None:
    """Create or merge a photo item at upload time.

    Immutable-ish identity fields use if_not_exists so a re-upload of the same
    bytes doesn't clobber them; categories are ADDed (merged) into the set;
    supplied metadata overwrites.
    """
    if not _ddb:
        return
    sets = [
        "createdAt = if_not_exists(createdAt, :now)",
        "filename = if_not_exists(filename, :fn)",
        "ext = if_not_exists(ext, :ext)",
        "contentType = if_not_exists(contentType, :ct)",
        "#ready = if_not_exists(#ready, :false)",
    ]
    names = {"#ready": "ready"}
    vals: dict[str, Any] = {
        ":now": int(time.time()),
        ":fn": filename,
        ":ext": ext,
        ":ct": content_type,
        ":false": False,
    }
    if description is not None:
        sets.append("description = :desc")
        vals[":desc"] = description
    if collection_id:
        sets.append("collectionId = :cid")
        vals[":cid"] = collection_id
    if lat is not None and lng is not None:
        sets.append("latitude = :lat")
        sets.append("longitude = :lng")
        vals[":lat"] = Decimal(str(lat))
        vals[":lng"] = Decimal(str(lng))

    expr = "SET " + ", ".join(sets)
    if categories:
        expr += " ADD categories :cats"
        vals[":cats"] = set(categories)

    _ddb.update_item(
        Key={"pk": PHOTO_PK, "sk": hash_},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=vals,
    )


def _presign_upload(body: dict) -> dict:
    hash_ = str(body.get("hash", "")).strip().lower()
    if not _HASH_RE.match(hash_):
        return _response(400, {"error": "invalid or missing content hash"})

    content_type = str(body.get("contentType", "")).lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        return _response(400, {"error": "unsupported content type"})
    ext = CONTENT_TYPE_EXT[content_type]

    filename = str(body.get("filename", "") or f"{hash_[:12]}.{ext}")[:160]
    categories = _clean_tags(body.get("categories"))
    collection_id = _safe_collection_id(body.get("collectionId")) if body.get("collectionId") else None
    description = _clean_description(body.get("description"))
    lat = _safe_coordinate(body.get("latitude"))
    lng = _safe_coordinate(body.get("longitude"))
    if (lat is None) != (lng is None):
        lat = lng = None
    if lat is not None and not (-90.0 <= lat <= 90.0):
        lat = lng = None

    key = f"{ORIGINALS_PREFIX}{hash_}.{ext}"
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

    _upsert_photo_on_upload(hash_, ext, filename, content_type,
                            categories, collection_id, description, lat, lng)

    return _response(200, {
        "url": post["url"],
        "fields": post["fields"],
        "key": key,
        "id": hash_,
    })


def _update_photo(photo_id: str, body: dict) -> dict:
    pid = str(photo_id or "").strip().lower()
    if not _HASH_RE.match(pid) or not _ddb:
        return _response(400, {"error": "invalid photo id"})

    item = _ddb.get_item(Key={"pk": PHOTO_PK, "sk": pid}).get("Item")
    if not item:
        return _response(404, {"error": "photo not found"})

    sets: list[str] = []
    removes: list[str] = []
    names: dict[str, str] = {}
    vals: dict[str, Any] = {}

    if "categories" in body:
        cats = _clean_tags(body.get("categories"))
        if cats:
            sets.append("categories = :cats")
            vals[":cats"] = set(cats)
        else:
            removes.append("categories")

    if "description" in body:
        desc = _clean_description(body.get("description"))
        if desc:
            sets.append("description = :desc")
            vals[":desc"] = desc
        else:
            removes.append("description")

    if "collectionId" in body:
        cid = _safe_collection_id(body.get("collectionId")) if body.get("collectionId") else None
        if cid:
            sets.append("collectionId = :cid")
            vals[":cid"] = cid
            order = body.get("collectionOrder")
            if order is not None:
                try:
                    vals[":co"] = int(order)
                except (TypeError, ValueError):
                    pass
                else:
                    sets.append("collectionOrder = :co")
        else:
            removes.append("collectionId")
            removes.append("collectionOrder")
    elif "collectionOrder" in body:
        # Append the clause only once the value parses, or DynamoDB rejects the
        # whole update for a placeholder with no matching value (a 500, not a 400).
        try:
            vals[":co"] = int(body["collectionOrder"])
        except (TypeError, ValueError):
            pass
        else:
            sets.append("collectionOrder = :co")

    if "latitude" in body or "longitude" in body:
        lat = _safe_coordinate(body.get("latitude"))
        lng = _safe_coordinate(body.get("longitude"))
        if lat is not None and lng is not None and -90.0 <= lat <= 90.0:
            sets.append("latitude = :lat")
            sets.append("longitude = :lng")
            vals[":lat"] = Decimal(str(lat))
            vals[":lng"] = Decimal(str(lng))
        else:
            removes.append("latitude")
            removes.append("longitude")

    if not sets and not removes:
        return _response(200, _photo_public(item))

    clauses = []
    if sets:
        clauses.append("SET " + ", ".join(sets))
    if removes:
        clauses.append("REMOVE " + ", ".join(removes))

    kwargs: dict[str, Any] = {
        "Key": {"pk": PHOTO_PK, "sk": pid},
        "UpdateExpression": " ".join(clauses),
        "ReturnValues": "ALL_NEW",
    }
    if vals:
        kwargs["ExpressionAttributeValues"] = vals
    if names:
        kwargs["ExpressionAttributeNames"] = names

    resp = _ddb.update_item(**kwargs)
    return _response(200, _photo_public(resp["Attributes"]))


def _delete_photo(photo_id: str) -> dict:
    pid = str(photo_id or "").strip().lower()
    if not _HASH_RE.match(pid) or not _ddb:
        return _response(400, {"error": "invalid photo id"})

    item = _ddb.get_item(Key={"pk": PHOTO_PK, "sk": pid}).get("Item")
    if not item:
        return _response(404, {"error": "photo not found"})

    obj = _photo_key(item)
    keys = [
        f"{ORIGINALS_PREFIX}{obj}",
        f"{DISPLAY_PREFIX}{obj}",
        f"{THUMBS_PREFIX}{obj}",
    ]
    _s3.delete_objects(
        Bucket=BUCKET,
        Delete={"Objects": [{"Key": k} for k in keys], "Quiet": True},
    )
    _ddb.delete_item(Key={"pk": PHOTO_PK, "sk": pid})
    return _response(200, {"deleted": pid})


# --- Collections -----------------------------------------------------------

def _create_collection(body: dict) -> dict:
    if not _ddb:
        return _response(500, {"error": "no catalog table"})
    title = str(body.get("title", "") or "").strip()[:120]
    if not title:
        return _response(400, {"error": "title is required"})
    description = _clean_description(body.get("description")) or ""
    cid = uuid.uuid4().hex
    _ddb.put_item(Item={
        "pk": COLLECTION_PK,
        "sk": cid,
        "title": title,
        "description": description,
        "createdAt": int(time.time()),
    })
    return _response(201, {"id": cid, "title": title, "description": description or None})


def _update_collection(cid: str, body: dict) -> dict:
    safe = _safe_collection_id(cid)
    if not safe or not _ddb:
        return _response(400, {"error": "invalid collection id"})
    existing = _ddb.get_item(Key={"pk": COLLECTION_PK, "sk": safe}).get("Item")
    if not existing:
        return _response(404, {"error": "collection not found"})

    sets: list[str] = []
    removes: list[str] = []
    vals: dict[str, Any] = {}
    if "title" in body:
        title = str(body.get("title", "") or "").strip()[:120]
        if not title:
            return _response(400, {"error": "title cannot be empty"})
        sets.append("title = :t")
        vals[":t"] = title
    if "description" in body:
        desc = _clean_description(body.get("description")) or ""
        sets.append("description = :d")
        vals[":d"] = desc
    if "coverPhotoId" in body:
        cover = str(body.get("coverPhotoId", "") or "").strip().lower()
        if cover and _HASH_RE.match(cover):
            sets.append("coverPhotoId = :c")
            vals[":c"] = cover
        else:
            removes.append("coverPhotoId")

    if not sets and not removes:
        return _response(200, {"id": safe})

    clauses = []
    if sets:
        clauses.append("SET " + ", ".join(sets))
    if removes:
        clauses.append("REMOVE " + ", ".join(removes))
    kwargs: dict[str, Any] = {
        "Key": {"pk": COLLECTION_PK, "sk": safe},
        "UpdateExpression": " ".join(clauses),
        "ReturnValues": "ALL_NEW",
    }
    if vals:
        kwargs["ExpressionAttributeValues"] = vals
    resp = _ddb.update_item(**kwargs)
    attrs = resp["Attributes"]
    return _response(200, {
        "id": safe,
        "title": str(attrs.get("title", safe)),
        "description": str(attrs.get("description", "")) or None,
        "coverPhotoId": attrs.get("coverPhotoId"),
    })


def _delete_collection(cid: str) -> dict:
    safe = _safe_collection_id(cid)
    if not safe or not _ddb:
        return _response(400, {"error": "invalid collection id"})
    # Unlink member photos.
    for p in _all_photos():
        if p.get("collectionId") == safe:
            _ddb.update_item(
                Key={"pk": PHOTO_PK, "sk": p["sk"]},
                UpdateExpression="REMOVE collectionId, collectionOrder",
            )
    _ddb.delete_item(Key={"pk": COLLECTION_PK, "sk": safe})
    return _response(200, {"deleted": safe})


# --- Tags (bulk operations across photos) ----------------------------------
# These touch the *stored* tag set only. Hashtag-derived tags live in the
# description text and stay as written — edit the description to change them.

def _rename_tag(name: str, body: dict) -> dict:
    old = _safe_name(name)
    new = _safe_name(body.get("newName", ""))
    if not old or not new or not _ddb:
        return _response(400, {"error": "invalid category name(s)"})
    if old == new:
        return _response(200, {"renamed": 0})
    old_key = _fold(old)
    count = 0
    for p in _all_photos():
        # The catalog shows one entry per fold key, so move every stored
        # spelling variant ("iss", "ISS"), not just the exact string.
        hits = {t for t in p.get("categories", set()) if _fold(t) == old_key}
        if not hits or hits == {new}:
            continue
        key = {"pk": PHOTO_PK, "sk": p["sk"]}
        _ddb.update_item(
            Key=key,
            UpdateExpression="DELETE categories :old",
            ExpressionAttributeValues={":old": hits},
        )
        _ddb.update_item(
            Key=key,
            UpdateExpression="ADD categories :new",
            ExpressionAttributeValues={":new": {new}},
        )
        count += 1
    return _response(200, {"renamed": count, "from": old, "to": new})


def _delete_tag(name: str) -> dict:
    old = _safe_name(name)
    if not old or not _ddb:
        return _response(400, {"error": "invalid category name"})
    old_key = _fold(old)
    count = 0
    for p in _all_photos():
        hits = {t for t in p.get("categories", set()) if _fold(t) == old_key}
        if hits:
            _ddb.update_item(
                Key={"pk": PHOTO_PK, "sk": p["sk"]},
                UpdateExpression="DELETE categories :old",
                ExpressionAttributeValues={":old": hits},
            )
            count += 1
    return _response(200, {"removed": count, "category": old})


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

def _jwt_claims(event: dict) -> dict | None:
    """Claims the API Gateway JWT authorizer attached, or None if it never ran.

    API Gateway builds requestContext, so a client cannot forge this. Checking
    it is not belt-and-braces: the `ANY /{proxy+}` catch-all route carries no
    authorizer, and several paths reach the Lambda as an admin request without
    ever matching the JWT-protected `.../api/admin/{proxy+}` routes — e.g.
    `/admin/uploads` on the public API Gateway URL (no `/api` prefix), or
    `/api//admin/uploads` (empty segment) through CloudFront.
    """
    auth = (event.get("requestContext") or {}).get("authorizer") or {}
    return (auth.get("jwt") or {}).get("claims") or None


def _route(method: str, path: str, body: dict | None, claims: dict | None = None) -> dict:
    parts = [p for p in path.strip("/").split("/") if p]
    if parts and parts[0] == "api":
        parts = parts[1:]

    if not parts:
        return _response(404, {"error": "not found"})

    if method == "OPTIONS":
        return _response(204, "")

    if method in ("GET", "HEAD"):
        if parts == ["health"]:
            return _response(200, {"status": "ok"})
        if parts == ["config"]:
            return _response(200, _config(), cache_seconds=300)
        if parts == ["catalog"]:
            return _response(200, _catalog(), cache_seconds=60)
        if parts == ["geo"]:
            return _response(200, {"images": _list_geotagged()}, cache_seconds=60)
        if parts == ["tags"] or parts == ["categories"]:
            tags = _tags_from(_all_photos())
            return _response(200, {"tags": tags, "categories": tags}, cache_seconds=60)
        if len(parts) == 2 and parts[0] in ("tags", "categories"):
            result = _list_tag(unquote(parts[1]))
            if result is None:
                return _response(404, {"error": "tag not found"})
            return _response(200, result, cache_seconds=60)
        if parts == ["collections"]:
            return _response(200, {"collections": _collections_from(_all_photos(), _all_collections())}, cache_seconds=60)
        if len(parts) == 2 and parts[0] == "collections":
            result = _collection_detail(unquote(parts[1]))
            if result is None:
                return _response(404, {"error": "collection not found"})
            return _response(200, result, cache_seconds=60)
        return _response(404, {"error": "not found"})

    # Admin writes — must carry authorizer claims, whatever route matched.
    if parts and parts[0] == "admin":
        if not claims:
            return _response(401, {"error": "unauthorized"})
        admin = parts[1:]
        b = body or {}
        if method == "POST" and admin == ["uploads"]:
            return _presign_upload(b)
        if method == "PUT" and len(admin) == 2 and admin[0] == "photos":
            return _update_photo(unquote(admin[1]), b)
        if method == "DELETE" and len(admin) == 2 and admin[0] == "photos":
            return _delete_photo(unquote(admin[1]))
        if method == "POST" and admin == ["collections"]:
            return _create_collection(b)
        if method == "PUT" and len(admin) == 2 and admin[0] == "collections":
            return _update_collection(unquote(admin[1]), b)
        if method == "DELETE" and len(admin) == 2 and admin[0] == "collections":
            return _delete_collection(unquote(admin[1]))
        if method == "PUT" and len(admin) == 2 and admin[0] in ("tags", "categories"):
            return _rename_tag(unquote(admin[1]), b)
        if method == "DELETE" and len(admin) == 2 and admin[0] in ("tags", "categories"):
            return _delete_tag(unquote(admin[1]))
        return _response(404, {"error": "not found"})

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
        return _route(method, path, body, _jwt_claims(event))
    except Exception:
        LOG.exception("unhandled error for %s %s", method, path)
        return _response(500, {"error": "internal error"})
