"""Unit tests for the image processor Lambda. Run: python3 tests/test_processor.py

Lives in tests/, not in lambda/processor/, so it stays out of the deploy zip.
"""

from __future__ import annotations

import io
import os
import sys
import time
import unittest
from decimal import Decimal
from unittest.mock import MagicMock, patch

# Configure environment before importing handler
os.environ.setdefault("IMAGE_BUCKET", "test-image-bucket")
os.environ.setdefault("CATALOG_TABLE", "test-catalog-table")
os.environ.setdefault("LOG_LEVEL", "ERROR")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "lambda", "processor"))

from PIL import Image, ImageDraw
import handler


class TestExtractGPS(unittest.TestCase):
    """Test EXIF GPS metadata extraction."""

    def _create_image_with_gps(self, lat: float, lon: float) -> Image.Image:
        img = Image.new("RGB", (100, 100), color=(200, 100, 50))
        exif = img.getexif()
        # GPSInfo tag ID is 34853 (0x8825)
        gps_ifd = exif.get_ifd(0x8825)

        from fractions import Fraction

        def _to_dms(deg_float: float):
            deg = int(abs(deg_float))
            min_float = (abs(deg_float) - deg) * 60.0
            minute = int(min_float)
            sec = round((min_float - minute) * 60.0, 4)
            return (Fraction(deg, 1), Fraction(minute, 1), Fraction(int(sec * 10000), 10000))

        gps_ifd[1] = "S" if lat < 0 else "N"
        gps_ifd[2] = _to_dms(lat)
        gps_ifd[3] = "W" if lon < 0 else "E"
        gps_ifd[4] = _to_dms(lon)

        out = io.BytesIO()
        img.save(out, format="JPEG", exif=exif)
        out.seek(0)
        return Image.open(out)

    def test_extract_gps_valid(self):
        # Zurich coordinates: ~47.3769 N, 8.5417 E
        img = self._create_image_with_gps(47.3769, 8.5417)
        gps = handler._extract_gps(img)
        self.assertIsNotNone(gps)
        lat, lon = gps
        self.assertAlmostEqual(lat, 47.3769, places=3)
        self.assertAlmostEqual(lon, 8.5417, places=3)

    def test_extract_gps_southern_western_hemisphere(self):
        # Buenos Aires coordinates: -34.6037 S, -58.3816 W
        img = self._create_image_with_gps(-34.6037, -58.3816)
        gps = handler._extract_gps(img)
        self.assertIsNotNone(gps)
        lat, lon = gps
        self.assertAlmostEqual(lat, -34.6037, places=3)
        self.assertAlmostEqual(lon, -58.3816, places=3)

    def test_extract_gps_none_when_missing(self):
        img = Image.new("RGB", (50, 50), color="white")
        self.assertIsNone(handler._extract_gps(img))


class TestResize(unittest.TestCase):
    """Test image resizing constraints and aspect ratio preservation."""

    def test_resize_smaller_than_max_is_not_scaled_up(self):
        img = Image.new("RGB", (300, 200), color="blue")
        resized = handler._resize(img, 400)
        self.assertEqual(resized.size, (300, 200))

    def test_resize_larger_than_max_landscape(self):
        img = Image.new("RGB", (3000, 1500), color="green")
        resized = handler._resize(img, 2048)
        self.assertEqual(resized.size, (2048, 1024))

    def test_resize_larger_than_max_portrait(self):
        img = Image.new("RGB", (1500, 3000), color="red")
        resized = handler._resize(img, 2048)
        self.assertEqual(resized.size, (1024, 2048))

    def test_resize_thumbnail(self):
        img = Image.new("RGB", (1200, 800), color="yellow")
        resized = handler._resize(img, 400)
        self.assertEqual(resized.size, (400, 267))


class TestEncode(unittest.TestCase):
    """Test format conversion and encoding options."""

    def test_encode_jpeg_rgb(self):
        img = Image.new("RGB", (100, 100), color="red")
        data, ct = handler._encode(img, "JPEG")
        self.assertEqual(ct, "image/jpeg")
        self.assertTrue(data.startswith(b"\xff\xd8"))

    def test_encode_jpeg_from_rgba_converts_mode(self):
        img = Image.new("RGBA", (100, 100), color=(255, 0, 0, 128))
        data, ct = handler._encode(img, "JPEG")
        self.assertEqual(ct, "image/jpeg")
        # Verify decoding back results in RGB
        with Image.open(io.BytesIO(data)) as decoded:
            self.assertEqual(decoded.mode, "RGB")

    def test_encode_png(self):
        img = Image.new("RGBA", (100, 100), color=(0, 255, 0, 200))
        data, ct = handler._encode(img, "PNG")
        self.assertEqual(ct, "image/png")
        self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_encode_webp(self):
        img = Image.new("RGB", (100, 100), color="blue")
        data, ct = handler._encode(img, "WEBP")
        self.assertEqual(ct, "image/webp")
        self.assertTrue(data.startswith(b"RIFF"))


class TestMarkReady(unittest.TestCase):
    """Test DynamoDB photo update behavior."""

    @patch.object(handler, "_ddb")
    def test_mark_ready_without_gps(self, mock_ddb):
        handler._mark_ready("test_id_1", "jpg", 1600, 1200, None)
        mock_ddb.update_item.assert_called_once()
        call_kwargs = mock_ddb.update_item.call_args.kwargs
        self.assertEqual(call_kwargs["Key"], {"pk": "PHOTO", "sk": "test_id_1"})
        self.assertIn("width = :w", call_kwargs["UpdateExpression"])
        self.assertEqual(call_kwargs["ExpressionAttributeValues"][":w"], 1600)
        self.assertEqual(call_kwargs["ExpressionAttributeValues"][":h"], 1200)
        self.assertEqual(call_kwargs["ExpressionAttributeValues"][":ext"], "jpg")
        self.assertNotIn(":lat", call_kwargs["ExpressionAttributeValues"])

    @patch.object(handler, "_ddb")
    def test_mark_ready_with_gps(self, mock_ddb):
        handler._mark_ready("test_id_2", "png", 800, 600, (47.3769123, 8.5417456))
        mock_ddb.update_item.assert_called_once()
        call_kwargs = mock_ddb.update_item.call_args.kwargs
        vals = call_kwargs["ExpressionAttributeValues"]
        self.assertEqual(vals[":lat"], Decimal("47.376912"))
        self.assertEqual(vals[":lon"], Decimal("8.541746"))

    @patch.object(handler, "_ddb")
    def test_mark_ready_with_ai_tags(self, mock_ddb):
        handler._mark_ready("test_id_3", "jpg", 1200, 800, None, ai_tags=["mountain", "lake"])
        mock_ddb.update_item.assert_called_once()
        call_kwargs = mock_ddb.update_item.call_args.kwargs
        self.assertIn("ai_tags = :aitags", call_kwargs["UpdateExpression"])
        self.assertEqual(call_kwargs["ExpressionAttributeValues"][":aitags"], {"mountain", "lake"})
        self.assertNotIn("ADD categories", call_kwargs["UpdateExpression"])

    @patch.object(handler, "REKOGNITION_AUTO_MERGE", True)
    @patch.object(handler, "_ddb")
    def test_mark_ready_with_ai_tags_auto_merge(self, mock_ddb):
        handler._mark_ready("test_id_4", "jpg", 1200, 800, None, ai_tags=["nature", "forest"])
        mock_ddb.update_item.assert_called_once()
        call_kwargs = mock_ddb.update_item.call_args.kwargs
        self.assertIn("ai_tags = :aitags", call_kwargs["UpdateExpression"])
        self.assertIn("ADD categories :aitags", call_kwargs["UpdateExpression"])


class TestRekognition(unittest.TestCase):
    """Test AWS Rekognition auto-tagging functions."""

    def test_normalize_tag(self):
        self.assertEqual(handler._normalize_tag("Mountain Peak"), "mountain-peak")
        self.assertEqual(handler._normalize_tag("Water_Sport!"), "water_sport")
        self.assertEqual(handler._normalize_tag("  Tree-Branch  "), "tree-branch")
        self.assertEqual(handler._normalize_tag("123 Sunset"), "123-sunset")

    def test_detect_labels_when_disabled(self):
        with patch.object(handler, "REKOGNITION_ENABLED", False):
            with patch.object(handler, "_rekognition") as mock_rek:
                result = handler._detect_labels(b"fake-bytes")
                self.assertEqual(result, [])
                mock_rek.detect_labels.assert_not_called()

    def test_detect_labels_success(self):
        mock_resp = {
            "Labels": [
                {"Name": "Landscape", "Confidence": 98.5},
                {"Name": "Mountain Peak", "Confidence": 94.2},
                {"Name": "Outdoors", "Confidence": 88.0},
            ]
        }
        with patch.object(handler, "REKOGNITION_ENABLED", True):
            with patch.object(handler, "REKOGNITION_MAX_LABELS", 2):
                with patch.object(handler, "_rekognition") as mock_rek:
                    mock_rek.detect_labels.return_value = mock_resp
                    result = handler._detect_labels(b"fake-bytes")
                    mock_rek.detect_labels.assert_called_once_with(
                        Image={"Bytes": b"fake-bytes"},
                        MaxLabels=2,
                        MinConfidence=handler.REKOGNITION_MIN_CONFIDENCE,
                    )
                    self.assertEqual(result, ["landscape", "mountain-peak"])

    def test_detect_labels_exception_handled_gracefully(self):
        with patch.object(handler, "REKOGNITION_ENABLED", True):
            with patch.object(handler, "_rekognition") as mock_rek:
                mock_rek.detect_labels.side_effect = Exception("AWS API error")
                result = handler._detect_labels(b"fake-bytes")
                self.assertEqual(result, [])


class TestProcessOneAndHandler(unittest.TestCase):
    """Test full processing pipeline with mocked S3 and DynamoDB."""

    def _create_sample_jpeg_bytes(self) -> bytes:
        img = Image.new("RGB", (1000, 800), color="purple")
        out = io.BytesIO()
        img.save(out, format="JPEG")
        return out.getvalue()

    @patch.object(handler, "_mark_ready")
    @patch.object(handler, "_s3")
    def test_process_one_success(self, mock_s3, mock_mark_ready):
        raw_bytes = self._create_sample_jpeg_bytes()
        mock_s3.get_object.return_value = {"Body": io.BytesIO(raw_bytes)}

        photo_hash = "f" * 64
        key = f"originals/{photo_hash}.jpg"
        handler._process_one(key)

        # S3 get called for original
        mock_s3.get_object.assert_called_once_with(Bucket=handler.BUCKET, Key=key)

        # S3 put called twice: once for display, once for thumb
        self.assertEqual(mock_s3.put_object.call_count, 2)
        put_keys = [call.kwargs["Key"] for call in mock_s3.put_object.call_args_list]
        self.assertIn(f"display/{photo_hash}.jpg", put_keys)
        self.assertIn(f"thumbs/{photo_hash}.jpg", put_keys)

        # mark_ready called with dimensions
        mock_mark_ready.assert_called_once()
        self.assertEqual(mock_mark_ready.call_args[0][0], photo_hash)
        self.assertEqual(mock_mark_ready.call_args[0][1], "jpg")
        self.assertEqual(mock_mark_ready.call_args[0][2], 1000)
        self.assertEqual(mock_mark_ready.call_args[0][3], 800)

    @patch.object(handler, "_process_one")
    def test_handler_event_processing(self, mock_process):
        event = {
            "Records": [
                {"s3": {"object": {"key": "originals/img1.jpg"}}},
                {"s3": {"object": {"key": "originals/img2%2Bspace.jpg"}}},
            ]
        }
        res = handler.handler(event, None)
        self.assertEqual(res["processed"], 2)
        self.assertEqual(res["failures"], [])
        self.assertEqual(mock_process.call_count, 2)
        mock_process.assert_any_call("originals/img1.jpg")
        mock_process.assert_any_call("originals/img2+space.jpg")


if __name__ == "__main__":
    unittest.main()
