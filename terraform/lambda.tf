################################################################################
# Gallery API: Lambda exposed via a Function URL (no API Gateway = cheaper, faster).
# Scales to zero. CloudFront fronts it for caching + custom domain.
################################################################################

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/api"
  output_path = "${path.module}/build/api.zip"
}

resource "aws_iam_role" "api" {
  name = "${local.project}-api"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "api_basic_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "api_inline" {
  statement {
    sid       = "ListImages"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.images.arn]
  }

  statement {
    sid       = "ReadImageMetadata"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.images.arn}/*"]
  }
}

resource "aws_iam_role_policy" "api_inline" {
  name   = "${local.project}-api-inline"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api_inline.json
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.project}-api"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_lambda_function" "api" {
  function_name = "${local.project}-api"
  role          = aws_iam_role.api.arn
  runtime       = "python3.12"
  handler       = "handler.handler"
  architectures = ["arm64"] # cheaper + faster cold start than x86

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  memory_size = var.lambda_memory_mb
  timeout     = 10

  environment {
    variables = {
      IMAGE_BUCKET = aws_s3_bucket.images.bucket
      IMAGE_HOST   = "https://${var.domain_name}"
      LOG_LEVEL    = "INFO"
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = [for h in local.all_aliases : "https://${h}"]
    allow_methods = ["GET"]
    allow_headers = ["content-type"]
    max_age       = 3600
  }
}

# Strip "https://" / trailing "/" so CloudFront can use it as an origin domain.
locals {
  api_url_host = replace(replace(aws_lambda_function_url.api.function_url, "https://", ""), "/", "")
}
