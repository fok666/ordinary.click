################################################################################
# Gallery API: Lambda exposed via API Gateway HTTP API.
# CloudFront fronts it for caching + custom domain.
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

  # Required to generate presigned POST URLs that the browser can use to
  # upload directly into the originals/ prefix.
  statement {
    sid       = "PresignUploadOriginals"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.images.arn}/originals/*"]
  }

  # Admins delete all three derivatives at once.
  statement {
    sid    = "DeleteImageDerivatives"
    effect = "Allow"
    actions = [
      "s3:DeleteObject",
    ]
    resources = [
      "${aws_s3_bucket.images.arn}/originals/*",
      "${aws_s3_bucket.images.arn}/categories/*",
      "${aws_s3_bucket.images.arn}/thumbs/*",
    ]
  }

  statement {
    sid    = "ImageMetadata"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:BatchGetItem",
      "dynamodb:Scan"
    ]
    resources = [aws_dynamodb_table.images.arn]
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
  architectures = ["arm64"]

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  memory_size = var.lambda_memory_mb
  timeout     = 10

  environment {
    variables = {
      IMAGE_BUCKET      = aws_s3_bucket.images.bucket
      IMAGE_HOST        = "https://${var.domain_name}"
      SITE_URL          = "https://${var.domain_name}"
      COGNITO_DOMAIN    = local.cognito_hosted_domain
      COGNITO_CLIENT_ID = aws_cognito_user_pool_client.site.id
      COGNITO_REGION    = var.aws_region
      METADATA_TABLE    = aws_dynamodb_table.images.name
      LOG_LEVEL         = "INFO"
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

################################################################################
# Image processor Lambda — bundled with Pillow, triggered by S3 events on
# uploads under originals/. Generates the display + thumb derivatives.
################################################################################

resource "null_resource" "processor_build" {
  triggers = {
    handler      = filemd5("${path.module}/../lambda/processor/handler.py")
    requirements = filemd5("${path.module}/../lambda/processor/requirements.txt")
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      build_dir="${path.module}/build/processor"
      rm -rf "$build_dir" "${path.module}/build/processor.zip"
      mkdir -p "$build_dir"
      cp ${path.module}/../lambda/processor/handler.py "$build_dir/"
      python3 -m pip install \
        --target "$build_dir" \
        --platform manylinux2014_aarch64 \
        --implementation cp \
        --python-version 3.12 \
        --only-binary=:all: \
        --upgrade \
        -r ${path.module}/../lambda/processor/requirements.txt
    EOT
  }
}

data "archive_file" "processor" {
  depends_on  = [null_resource.processor_build]
  type        = "zip"
  source_dir  = "${path.module}/build/processor"
  output_path = "${path.module}/build/processor.zip"
}

resource "aws_iam_role" "processor" {
  name = "${local.project}-processor"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "processor_basic_logs" {
  role       = aws_iam_role.processor.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "processor_inline" {
  statement {
    sid       = "ReadOriginals"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.images.arn}/originals/*"]
  }

  statement {
    sid    = "WriteDerivatives"
    effect = "Allow"
    actions = [
      "s3:PutObject",
    ]
    resources = [
      "${aws_s3_bucket.images.arn}/categories/*",
      "${aws_s3_bucket.images.arn}/thumbs/*",
    ]
  }

  statement {
    sid    = "WriteImageMetadata"
    effect = "Allow"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.images.arn]
  }
}

resource "aws_iam_role_policy" "processor_inline" {
  name   = "${local.project}-processor-inline"
  role   = aws_iam_role.processor.id
  policy = data.aws_iam_policy_document.processor_inline.json
}

resource "aws_cloudwatch_log_group" "processor" {
  name              = "/aws/lambda/${local.project}-processor"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_lambda_function" "processor" {
  function_name = "${local.project}-processor"
  role          = aws_iam_role.processor.arn
  runtime       = "python3.12"
  handler       = "handler.handler"
  architectures = ["arm64"]

  filename         = data.archive_file.processor.output_path
  source_code_hash = data.archive_file.processor.output_base64sha256

  memory_size = var.processor_memory_mb
  timeout     = 60

  environment {
    variables = {
      IMAGE_BUCKET   = aws_s3_bucket.images.bucket
      METADATA_TABLE = aws_dynamodb_table.images.name
      DISPLAY_MAX_PX = "2048"
      THUMB_MAX_PX   = "400"
      JPEG_QUALITY   = "85"
      LOG_LEVEL      = "INFO"
    }
  }

  depends_on = [aws_cloudwatch_log_group.processor]
}

resource "aws_lambda_permission" "processor_s3" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.processor.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.images.arn
}

resource "aws_s3_bucket_notification" "images" {
  bucket = aws_s3_bucket.images.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.processor.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "originals/"
  }

  depends_on = [aws_lambda_permission.processor_s3]
}

################################################################################
# API Gateway HTTP API in front of the Lambda.
################################################################################

resource "aws_apigatewayv2_api" "api" {
  name          = "${local.project}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["https://${var.domain_name}"]
    allow_methods = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.api.id
  name             = "${local.project}-cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.site.id]
    issuer   = local.cognito_issuer
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# Public catch-all (GET reads + /api/config + /api/health).
resource "aws_apigatewayv2_route" "api_public" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

# Admin routes — JWT-protected. More specific than the catch-all so they win.
resource "aws_apigatewayv2_route" "api_admin_post" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "POST /api/admin/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "api_admin_delete" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "DELETE /api/admin/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "api_admin_put" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "PUT /api/admin/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_stage" "api" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# Strip "https://" / trailing "/" so CloudFront can use it as an origin domain.
locals {
  api_url_host = replace(replace(aws_apigatewayv2_api.api.api_endpoint, "https://", ""), "/", "")
}
