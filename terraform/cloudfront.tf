################################################################################
# CloudFront distribution — single entry point in front of:
#   - S3 site bucket           (default)
#   - S3 image bucket          (/images/*)
#   - API Gateway HTTP API     (/api/*)
################################################################################

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${local.project}-site-oac"
  description                       = "OAC for site bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "images" {
  name                              = "${local.project}-images-oac"
  description                       = "OAC for image bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Managed policy IDs
# https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html
locals {
  cache_policy_optimized            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
  origin_request_policy_all_no_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader
  response_headers_security         = "67f7725c-6f97-4210-82d7-5512b31e9d03" # SecurityHeadersPolicy
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${local.project} gallery"
  default_root_object = "index.html"
  price_class         = var.price_class
  http_version        = "http2and3"
  aliases             = local.all_aliases

  # --- Origins ---------------------------------------------------------------
  origin {
    origin_id                = "s3-site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id                = "s3-images"
    domain_name              = aws_s3_bucket.images.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.images.id
  }

  origin {
    origin_id   = "lambda-api"
    domain_name = local.api_url_host

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  # --- Default behaviour: site ----------------------------------------------
  default_cache_behavior {
    target_origin_id       = "s3-site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = local.cache_policy_optimized
    response_headers_policy_id = local.response_headers_security
  }

  # --- Images: long cache, no query strings --------------------------------
  # Public URL prefix is /images/* but the S3 bucket lays files out under
  # display/<id>.<ext>. A viewer-request CloudFront Function rewrites
  # /images/... -> /display/... before the S3 lookup.
  ordered_cache_behavior {
    path_pattern           = "/images/*"
    target_origin_id       = "s3-images"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = local.cache_policy_optimized
    response_headers_policy_id = local.response_headers_security

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.images_rewrite.arn
    }
  }

  # --- API: short cache, forward query strings + auth headers --------------
  # Origin is API Gateway HTTP API. AllViewerExceptHostHeader forwards viewer
  # headers (including Authorization) but lets CloudFront set Host to the API
  # Gateway hostname. POST/PUT/DELETE are required for admin endpoints.
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "lambda-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = aws_cloudfront_cache_policy.api.id
    origin_request_policy_id   = local.origin_request_policy_all_no_host
    response_headers_policy_id = local.response_headers_security
  }

  # --- Thumbnails: long cache, served straight from the images bucket -------
  # Bucket key is `thumbs/<id>.<ext>` so no rewrite is needed.
  ordered_cache_behavior {
    path_pattern           = "/thumbs/*"
    target_origin_id       = "s3-images"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = local.cache_policy_optimized
    response_headers_policy_id = local.response_headers_security
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # No custom_error_response here on purpose. It is distribution-wide, so a
  # 403/404 -> 200 /index.html rewrite also hits /api/*: "category not found"
  # and an expired-JWT rejection both came back as 200 with an HTML body, which
  # the SPA then tried to JSON.parse. Routing is hash-based (#/c/<name>), so
  # every real URL is / and the fallback bought nothing.
}

# Rewrites /images/<...> to /display/<...> at the edge so the public URL
# space stays clean while the bucket layout uses display/ as the prefix.
resource "aws_cloudfront_function" "images_rewrite" {
  name    = "${local.project}-images-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite /images/* to /display/* for the s3-images origin"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var req = event.request;
      if (req.uri.indexOf("/images/") === 0) {
        req.uri = "/display/" + req.uri.substring("/images/".length);
      }
      return req;
    }
  EOT
}

resource "aws_cloudfront_cache_policy" "api" {
  name        = "${local.project}-api"
  default_ttl = 60
  max_ttl     = 300
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "all"
    }
  }
}
