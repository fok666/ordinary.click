"""Auth checks for the gallery API router. Run: python3 tests/test_api_handler.py

Lives in tests/, not in lambda/api/, so it stays out of the deploy zip.
"""

import os
import sys
from unittest.mock import MagicMock

for _mod in ("boto3", "boto3.dynamodb", "boto3.dynamodb.conditions", "botocore", "botocore.config"):
    sys.modules.setdefault(_mod, MagicMock())

os.environ.setdefault("IMAGE_BUCKET", "test-bucket")
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "lambda", "api"))

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

    # Non-ASCII tags: umlauts must not truncate hashtags or fail validation,
    # and decomposed input (u + combining diaeresis) must normalize to NFC.
    got = handler._photo_tags({"description": "Ein #grünes Auto, #Übermut"})
    assert got == {"grünes", "Übermut"}, got
    assert handler._clean_tags(["gr\u00fcn", "gru\u0308n", "\u00d6l 2.0"]) == ["gr\u00fcn", "\u00d6l 2.0"]
    assert handler._clean_description("gru\u0308n") == "gr\u00fcn"

    # Fold-based dedup: case/diacritic spelling variants are one tag.
    assert handler._fold("ISS") == handler._fold("iss")
    assert handler._fold("m\u00fcnchen") == handler._fold("munchen")
    assert handler._clean_tags(["ISS", "iss", "m\u00fcnchen", "munchen"]) == ["ISS", "m\u00fcnchen"]
    # Stored spelling wins over a fold-equal hashtag in the description.
    got = handler._photo_tags({"categories": {"munchen"}, "description": "#m\u00fcnchen #glyptothek"})
    assert got == {"munchen", "glyptothek"}, got
    # Catalog groups variants into one entry, first-seen spelling displays.
    tags = handler._tags_from([
        {"ready": True, "sk": "a", "categories": {"ISS"}},
        {"ready": True, "sk": "b", "categories": {"iss"}},
    ])
    assert [(t["name"], t["count"]) for t in tags] == [("ISS", 2)], tags

    # Single-photo tags hide when their photo has other tags; a photo whose
    # tags would ALL hide keeps its alphabetically-first one (no orphans).
    tags = handler._tags_from([
        {"ready": True, "sk": "a", "categories": {"munich", "solo"}},  # solo: 1 photo w/ 2 tags
        {"ready": True, "sk": "b", "categories": {"munich"}},          # munich: 2 photos
        {"ready": True, "sk": "c", "categories": {"one"}},             # photo's only tag
        {"ready": True, "sk": "d", "categories": {"foo", "bar"}},      # both would hide -> keep "bar"
    ])
    assert len(tags) == 5, tags  # hidden entries still present for admins
    vis = {t["name"] for t in tags if not t.get("hidden")}
    assert vis == {"munich", "one", "bar"}, vis

    # _photo_public includes createdAt and updatedAt if present
    pub = handler._photo_public({
        "sk": "p1",
        "ready": True,
        "createdAt": 1700000000,
        "updatedAt": 1700001000,
    })
    assert pub["createdAt"] == 1700000000, pub
    assert pub["updatedAt"] == 1700001000, pub

    # GET /api/photos endpoint returns 200 with photos array
    resp = call("GET", "/api/photos")
    assert resp["statusCode"] == 200, resp
    assert "photos" in resp["body"], resp

    # _photo_public includes ai_tags if present
    pub_with_ai = handler._photo_public({
        "sk": "p2",
        "ready": True,
        "ai_tags": {"nature", "sunset"},
    })
    assert pub_with_ai.get("ai_tags") == ["nature", "sunset"], pub_with_ai

    # Test _update_photo with approveAiTags
    mock_ddb = MagicMock()
    handler._ddb = mock_ddb
    mock_item = {"pk": "PHOTO", "sk": HASH, "categories": {"nature"}, "ai_tags": {"forest", "mountain"}}
    mock_ddb.get_item.return_value = {"Item": mock_item}
    mock_ddb.update_item.return_value = {
        "Attributes": {
            "sk": HASH,
            "ready": True,
            "categories": {"nature", "forest", "mountain"},
        }
    }
    res = handler._update_photo(HASH, {"approveAiTags": True})
    assert res["statusCode"] == 200, res
    call_args = mock_ddb.update_item.call_args.kwargs
    assert "categories = :cats" in call_args["UpdateExpression"]
    assert "REMOVE ai_tags" in call_args["UpdateExpression"]

    # Test _rename_tag compound atomic UpdateExpression
    mock_ddb.reset_mock()
    handler._all_photos = lambda: [
        {"pk": "PHOTO", "sk": "photo1", "categories": {"nature", "landscape"}},
        {"pk": "PHOTO", "sk": "photo2", "categories": {"urban"}},
    ]
    rename_res = handler._rename_tag("nature", {"newName": "wildlife"})
    assert rename_res["statusCode"] == 200, rename_res
    assert mock_ddb.update_item.call_count == 1, f"Expected 1 atomic update, got {mock_ddb.update_item.call_count}"
    rename_args = mock_ddb.update_item.call_args.kwargs
    assert rename_args["UpdateExpression"] == "DELETE categories :old ADD categories :new"
    assert rename_args["ExpressionAttributeValues"][":old"] == {"nature"}
    assert rename_args["ExpressionAttributeValues"][":new"] == {"wildlife"}

    # Test _rename_tag no-op when names match
    mock_ddb.reset_mock()
    noop_res = handler._rename_tag("nature", {"newName": "nature"})
    assert noop_res["statusCode"] == 200
    assert mock_ddb.update_item.call_count == 0

    print("ok")


if __name__ == "__main__":
    demo()
