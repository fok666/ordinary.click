#!/usr/bin/env python3
"""Zero-dependency local development server with mock API for ordinary.click.

Usage:
    python3 scripts/dev-server.py [port]
    Default port: 8000

Features:
- Serves static files from site/ with proper MIME types and no caching.
- Mock API endpoints:
    GET  /api/config
    GET  /api/catalog
    GET  /api/tags
    GET  /api/tags/<name>
    GET  /api/collections
    GET  /api/collections/<id>
    GET  /api/geo
    GET  /api/health
    POST /api/admin/uploads
    POST /api/admin/photos/<id>
    PUT  /api/admin/photos/<id>
    DELETE /api/admin/photos/<id>
    POST /api/admin/collections
    PUT  /api/admin/collections/<id>
    DELETE /api/admin/collections/<id>
    GET  /api/dev/auth  (provides a mock JWT token for offline admin testing)
- Dynamic image generator for /images/<id>.<ext> and /thumbs/<id>.<ext>
  so local development does not require S3 or CloudFront.
"""

from __future__ import annotations

import base64
import http.server
import json
import os
import re
import socketserver
import sys
import time
import urllib.parse
from typing import Any

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_DIR = os.path.join(REPO_ROOT, "site")

# ---------------------------------------------------------------------------
# In-Memory Mock Catalog
# ---------------------------------------------------------------------------

MOCK_PHOTOS = [
    {
        "id": "mock_photo_1",
        "url": "/images/mock_photo_1.jpg",
        "thumb": "/thumbs/mock_photo_1.jpg",
        "categories": ["nature", "forest"],
        "tags": ["nature", "forest", "sunlight"],
        "description": "Golden hour through the tall pine trees. #sunlight",
        "ready": True,
        "width": 1600,
        "height": 1067,
        "collectionId": "c_travel",
        "latitude": 47.3769,
        "longitude": 8.5417,
        "createdAt": 1710000000,
        "updatedAt": 1710000000,
        "filename": "forest-light.jpg",
    },
    {
        "id": "mock_photo_2",
        "url": "/images/mock_photo_2.jpg",
        "thumb": "/thumbs/mock_photo_2.jpg",
        "categories": ["architecture", "street"],
        "tags": ["architecture", "street", "brutalist"],
        "description": "Geometric facade on a cloudy afternoon. #brutalist",
        "ready": True,
        "width": 1200,
        "height": 1200,
        "collectionId": "c_travel",
        "latitude": 47.3686,
        "longitude": 8.5392,
        "createdAt": 1710100000,
        "updatedAt": 1710100000,
        "filename": "concrete-grid.jpg",
    },
    {
        "id": "mock_photo_3",
        "url": "/images/mock_photo_3.jpg",
        "thumb": "/thumbs/mock_photo_3.jpg",
        "categories": ["nature", "water"],
        "tags": ["nature", "water", "mist"],
        "description": "Gentle morning mist hovering over the cold lake. #mist",
        "ready": True,
        "width": 1800,
        "height": 1200,
        "collectionId": "c_water",
        "latitude": 47.3500,
        "longitude": 8.5500,
        "createdAt": 1710200000,
        "updatedAt": 1710200000,
        "filename": "misty-lake.jpg",
    },
    {
        "id": "mock_photo_4",
        "url": "/images/mock_photo_4.jpg",
        "thumb": "/thumbs/mock_photo_4.jpg",
        "categories": ["street", "minimal"],
        "tags": ["street", "minimal", "shadows"],
        "description": "Lone cyclist crossing the empty plaza at dawn. #shadows",
        "ready": True,
        "width": 1400,
        "height": 933,
        "collectionId": "",
        "latitude": 47.3780,
        "longitude": 8.5400,
        "createdAt": 1710300000,
        "updatedAt": 1710300000,
        "filename": "empty-plaza.jpg",
    },
    {
        "id": "mock_photo_5",
        "url": "/images/mock_photo_5.jpg",
        "thumb": "/thumbs/mock_photo_5.jpg",
        "categories": ["architecture"],
        "tags": ["architecture", "modern"],
        "description": "Curved glass staircase reflecting daylight. #modern",
        "ready": True,
        "width": 1200,
        "height": 1600,
        "collectionId": "c_travel",
        "latitude": 48.1351,
        "longitude": 11.5820,
        "createdAt": 1710400000,
        "updatedAt": 1710400000,
        "filename": "glass-spiral.jpg",
    },
    {
        "id": "mock_photo_6",
        "url": "/images/mock_photo_6.jpg",
        "thumb": "/thumbs/mock_photo_6.jpg",
        "categories": ["coffee", "still-life"],
        "tags": ["coffee", "still-life", "morning"],
        "description": "Ceramic cup, notebook, and quiet minutes before work. #morning",
        "ready": True,
        "width": 1500,
        "height": 1000,
        "collectionId": "",
        "latitude": 48.1374,
        "longitude": 11.5755,
        "createdAt": 1710500000,
        "updatedAt": 1710500000,
        "filename": "morning-coffee.jpg",
    },
]

MOCK_COLLECTIONS = [
    {
        "id": "c_travel",
        "title": "Urban Exploration",
        "description": "Architecture, streets, and quiet corners from recent travels.",
        "cover": "/thumbs/mock_photo_2.jpg",
        "count": 3,
        "createdAt": 1710000000,
        "updatedAt": 1710400000,
    },
    {
        "id": "c_water",
        "title": "By the Water",
        "description": "Lakes, rivers, and coastal moods.",
        "cover": "/thumbs/mock_photo_3.jpg",
        "count": 1,
        "createdAt": 1710200000,
        "updatedAt": 1710200000,
    },
]


def _make_mock_jwt(email: str = "dev@ordinary.click") -> str:
    """Generate an unverified JWT token valid for 24h for local testing."""
    header = base64.urlsafe_b64encode(b'{"alg":"none","typ":"JWT"}').decode().rstrip("=")
    exp = int(time.time()) + 86400
    payload = {
        "sub": "mock-dev-user-id",
        "email": email,
        "cognito:username": "dev-admin",
        "exp": exp,
        "iat": int(time.time()),
    }
    payload_b64 = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"{header}.{payload_b64}."


def _generate_svg_placeholder(photo_id: str, is_thumb: bool = False) -> bytes:
    """Generate an attractive SVG image placeholder."""
    hue = (hash(photo_id) % 360 + 360) % 360
    w = 400 if is_thumb else 1200
    h = 300 if is_thumb else 800
    label = f"{photo_id} ({'thumb' if is_thumb else 'display'})"
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="hsl({hue}, 35%, 30%)" />
      <stop offset="100%" stop-color="hsl({(hue + 45) % 360}, 45%, 15%)" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)" />
  <circle cx="{w // 2}" cy="{h // 2 - 20}" r="{min(w, h) // 5}" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="2" />
  <text x="{w // 2}" y="{h // 2 + 30}" font-family="sans-serif" font-size="{14 if is_thumb else 22}" fill="rgba(255,255,255,0.85)" text-anchor="middle">{label}</text>
</svg>"""
    return svg.encode("utf-8")


class GalleryDevHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler supporting static files from site/ and mock API routes."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=SITE_DIR, **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def _send_json(self, data: Any, code: int = 200) -> None:
        body = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 1. API: Config
        if path == "/api/config":
            return self._send_json({
                "cognito": {
                    "domain": "localhost:8000",
                    "clientId": "mock-local-client",
                    "redirectUri": "http://localhost:8000/",
                    "logoutUri": "http://localhost:8000/",
                },
                "devMode": True,
            })

        # 2. API: Health
        if path == "/api/health":
            return self._send_json({"status": "ok", "photos": len(MOCK_PHOTOS)})

        # 3. API: Dev mock auth token
        if path == "/api/dev/auth":
            token = _make_mock_jwt()
            return self._send_json({
                "id_token": token,
                "access_token": token,
                "token_type": "Bearer",
                "expires_in": 86400,
            })

        # 4. API: Catalog
        if path == "/api/catalog":
            tag_counts: dict[str, int] = {}
            for p in MOCK_PHOTOS:
                for t in p.get("tags") or p.get("categories") or []:
                    tag_counts[t] = tag_counts.get(t, 0) + 1

            tags = [
                {"name": name, "count": count, "cover": f"/thumbs/{name}_cover.jpg"}
                for name, count in sorted(tag_counts.items(), key=lambda x: (-x[1], x[0]))
            ]
            return self._send_json({
                "tags": tags,
                "collections": MOCK_COLLECTIONS,
                "totals": {
                    "photos": len(MOCK_PHOTOS),
                    "tags": len(tags),
                    "collections": len(MOCK_COLLECTIONS),
                },
            })

        # 4b. API: All photos
        if path == "/api/photos":
            sorted_photos = sorted(MOCK_PHOTOS, key=lambda x: x.get("createdAt", 0), reverse=True)
            return self._send_json({"photos": sorted_photos})

        # 5. API: Tags list
        if path == "/api/tags" or path == "/api/categories":
            tag_counts = {}
            for p in MOCK_PHOTOS:
                for t in p.get("tags") or p.get("categories") or []:
                    tag_counts[t] = tag_counts.get(t, 0) + 1
            return self._send_json({
                "tags": [{"name": k, "count": v} for k, v in tag_counts.items()]
            })

        # 6. API: Single tag photos
        m_tag = re.match(r"^/api/(?:tags|categories)/([^/]+)$", path)
        if m_tag:
            tag_name = urllib.parse.unquote(m_tag.group(1)).lower()
            matching = [
                p for p in MOCK_PHOTOS
                if any(t.lower() == tag_name for t in (p.get("tags") or p.get("categories") or []))
            ]
            return self._send_json({"name": tag_name, "images": matching})

        # 7. API: Collections list
        if path == "/api/collections":
            return self._send_json({"collections": MOCK_COLLECTIONS})

        # 8. API: Single collection photos
        m_coll = re.match(r"^/api/collections/([^/]+)$", path)
        if m_coll:
            coll_id = urllib.parse.unquote(m_coll.group(1))
            coll = next((c for c in MOCK_COLLECTIONS if c["id"] == coll_id), None)
            if not coll:
                return self._send_json({"error": "Collection not found"}, 404)
            matching = [p for p in MOCK_PHOTOS if p.get("collectionId") == coll_id]
            return self._send_json({
                "id": coll["id"],
                "title": coll["title"],
                "description": coll.get("description", ""),
                "images": matching,
            })

        # 9. API: Geo photos
        if path == "/api/geo":
            geo_photos = [
                p for p in MOCK_PHOTOS
                if p.get("latitude") is not None and p.get("longitude") is not None
            ]
            return self._send_json({"images": geo_photos})

        # 10. Local Image Placeholders
        m_img = re.match(r"^/(images|thumbs)/([^/]+)\.(jpg|jpeg|png|webp|svg)$", path, re.I)
        if m_img:
            kind, photo_id = m_img.group(1), m_img.group(2)
            svg_data = _generate_svg_placeholder(photo_id, is_thumb=(kind == "thumbs"))
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(svg_data)))
            self.end_headers()
            self.wfile.write(svg_data)
            return

        # 11. Static files from site/
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}

        # Admin: Presigned upload mock
        if path == "/api/admin/uploads":
            photo_hash = body.get("hash", f"mock_{int(time.time())}")
            ext = body.get("ext", "jpg")
            new_id = f"mock_{photo_hash[:12]}"
            MOCK_PHOTOS.append({
                "id": new_id,
                "url": f"/images/{new_id}.{ext}",
                "thumb": f"/thumbs/{new_id}.{ext}",
                "categories": body.get("categories", []),
                "tags": body.get("categories", []),
                "description": body.get("description", "Uploaded in dev mode"),
                "ready": True,
                "width": 1200,
                "height": 800,
                "collectionId": body.get("collectionId", ""),
                "createdAt": int(time.time()),
                "updatedAt": int(time.time()),
                "filename": body.get("filename", f"{new_id}.{ext}"),
            })
            return self._send_json({
                "url": f"http://localhost:8000/api/dev/mock-upload-receiver?id={new_id}",
                "photoId": new_id,
                "fields": {},
            })

        # Admin: Create collection
        if path == "/api/admin/collections":
            new_id = f"c_{int(time.time())}"
            coll = {
                "id": new_id,
                "title": body.get("title", "New Collection"),
                "description": body.get("description", ""),
                "cover": "/thumbs/mock_photo_1.jpg",
                "count": 0,
                "createdAt": int(time.time()),
                "updatedAt": int(time.time()),
            }
            MOCK_COLLECTIONS.append(coll)
            return self._send_json(coll, 201)

        # Admin: Edit photo metadata
        m_photo = re.match(r"^/api/admin/photos/([^/]+)$", path)
        if m_photo:
            photo_id = m_photo.group(1)
            photo = next((p for p in MOCK_PHOTOS if p["id"] == photo_id), None)
            if not photo:
                return self._send_json({"error": "Photo not found"}, 404)
            if "description" in body:
                photo["description"] = body["description"]
            if "categories" in body:
                photo["categories"] = list(body["categories"])
                photo["tags"] = list(body["categories"])
            if "collectionId" in body:
                photo["collectionId"] = body["collectionId"]
            if "latitude" in body:
                photo["latitude"] = body["latitude"]
            if "longitude" in body:
                photo["longitude"] = body["longitude"]
            photo["updatedAt"] = int(time.time())
            return self._send_json(photo)

        return self._send_json({"error": "Not found"}, 404)

    def do_PUT(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}

        # Admin: Edit collection
        m_coll = re.match(r"^/api/admin/collections/([^/]+)$", path)
        if m_coll:
            coll_id = m_coll.group(1)
            coll = next((c for c in MOCK_COLLECTIONS if c["id"] == coll_id), None)
            if not coll:
                return self._send_json({"error": "Collection not found"}, 404)
            if "title" in body:
                coll["title"] = body["title"]
            if "description" in body:
                coll["description"] = body["description"]
            coll["updatedAt"] = int(time.time())
            return self._send_json(coll)

        return self.do_POST()

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # Admin: Delete photo
        m_photo = re.match(r"^/api/admin/photos/([^/]+)$", path)
        if m_photo:
            photo_id = m_photo.group(1)
            idx = next((i for i, p in enumerate(MOCK_PHOTOS) if p["id"] == photo_id), None)
            if idx is not None:
                MOCK_PHOTOS.pop(idx)
                return self._send_json({"deleted": photo_id})
            return self._send_json({"error": "Photo not found"}, 404)

        # Admin: Delete collection
        m_coll = re.match(r"^/api/admin/collections/([^/]+)$", path)
        if m_coll:
            coll_id = m_coll.group(1)
            idx = next((i for i, c in enumerate(MOCK_COLLECTIONS) if c["id"] == coll_id), None)
            if idx is not None:
                MOCK_COLLECTIONS.pop(idx)
                return self._send_json({"deleted": coll_id})
            return self._send_json({"error": "Collection not found"}, 404)

        return self._send_json({"error": "Not found"}, 404)


def run(port: int = 8000) -> None:
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", port), GalleryDevHandler) as httpd:
        print(f"ordinary.click local dev server running at: http://localhost:{port}")
        print(f"Serving static site from: {SITE_DIR}")
        print(f"Mock API active at: http://localhost:{port}/api/catalog")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nDev server stopped.")


if __name__ == "__main__":
    port_arg = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    run(port_arg)
