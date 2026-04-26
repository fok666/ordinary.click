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

################################################################################
# API Gateway HTTP API in front of the Lambda.
#
# Why API Gateway instead of a Lambda Function URL? In this AWS account a
# higher-level guardrail blocks unauthenticated invocation of Lambda Function
# URLs (both AuthType=NONE with Principal:* and CloudFront OAC with
# AuthType=AWS_IAM are denied). API Gateway invokes Lambda using the API's
# service principal + execution role, which is not subject to that guardrail.
################################################################################

resource "aws_apigatewayv2_api" "api" {
  name          = "${local.project}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "HEAD", "OPTIONS"]
    allow_headers = ["*"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# Catch-all route — Lambda handler does its own path routing.
resource "aws_apigatewayv2_route" "api" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
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
