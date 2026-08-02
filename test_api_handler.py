"""Auth checks for the gallery API router. Run: python3 test_api_handler.py

Lives at the repo root, not in lambda/api/, so it stays out of the deploy zip.
"""

import os
import sys
from unittest.mock import MagicMock

for _mod in ("boto3", "boto3.dynamodb", "boto3.dynamodb.conditions", "botocore", "botocore.config"):
    sys.modules.setdefault(_mod, MagicMock())

os.environ.setdefault("IMAGE_BUCKET", "test-bucket")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lambda", "api"))

import handler  # noqa: E402

HASH = "a" * 64
CLAIMS = {"requestContext": {"authorizer": {"jwt": {"claims": {"email": "you@example.com"}}}}}


def call(method, path, body=None, event=None):
    ev = {"requestContext": {"http": {"method": method, "path": path}}, "rawPath": path}
    if event:
        ev["requestContext"] = event["requestContext"]
    return handler._route(method, path, body or {}, handler._jwt_claims(ev))


def demo():
    # The `ANY /{proxy+}` catch-all carries no authorizer, so these three reach
    # the Lambda as admin requests without API Gateway ever checking a JWT.
    for method, path in [
        ("POST", "/admin/uploads"),                  # direct API Gateway URL, no /api prefix
        ("POST", "/api//admin/uploads"),             # empty segment dodges POST /api/admin/{proxy+}
        ("DELETE", f"/admin/photos/{HASH}"),
        ("DELETE", f"/api//admin/photos/{HASH}"),
        ("PUT", f"/api//admin/categories/holidays"),
        ("PUT", f"/api//admin/tags/holidays"),
    ]:
        got = call(method, path)["statusCode"]
        assert got == 401, f"{method} {path} must be 401 without claims, got {got}"

    # ...and a real authorized call still gets through to the handler body.
    authed = call("POST", "/api/admin/uploads", {"hash": "nope"}, CLAIMS)
    assert authed["statusCode"] == 400, authed          # rejected on the bad hash, not on auth
    assert "content hash" in authed["body"], authed

    # Public reads stay public.
    assert call("GET", "/api/health")["statusCode"] == 200

    # Effective tags = stored set + description #hashtags. Sentence punctuation,
    # escaped entities ("&#39;") and infix hashes ("not#tag") must not match.
    got = handler._photo_tags({
        "categories": {"cars"},
        "description": "A #Sunset drive. #v1.0 it&#39;s not#tag",
    })
    assert got == {"cars", "Sunset", "v1.0"}, got
    assert handler._photo_tags({}) == set()

    print("ok")


if __name__ == "__main__":
    demo()
