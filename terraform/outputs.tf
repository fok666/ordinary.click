output "site_bucket" {
  description = "S3 bucket holding the static site (HTML/CSS/JS)."
  value       = aws_s3_bucket.site.bucket
}

output "images_bucket" {
  description = "S3 bucket holding gallery images. Upload under categories/<category>/<file>."
  value       = aws_s3_bucket.images.bucket
}

output "cloudfront_distribution_id" {
  description = "ID used for cache invalidations after deploys."
  value       = aws_cloudfront_distribution.site.id
}

output "cloudfront_domain_name" {
  description = "CloudFront default hostname (useful before DNS propagates)."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "api_endpoint" {
  description = "Direct API Gateway endpoint of the gallery API (CloudFront fronts it at /api/*)."
  value       = aws_apigatewayv2_api.api.api_endpoint
}

output "cognito_user_pool_id" {
  description = "Cognito user pool ID (use to create admin users via aws cognito-idp admin-create-user)."
  value       = aws_cognito_user_pool.admins.id
}

output "cognito_client_id" {
  description = "Cognito app client ID consumed by the SPA (also returned via /api/config)."
  value       = aws_cognito_user_pool_client.site.id
}

output "cognito_hosted_ui_domain" {
  description = "Cognito hosted UI domain (the SPA redirects here for login)."
  value       = local.cognito_hosted_domain
}

output "github_deployer_role_arn" {
  description = "Role ARN used by GitHub Actions OIDC for deployments."
  value       = aws_iam_role.github_deployer.arn
}

output "route53_name_servers" {
  description = "Set these as the NS records at your domain registrar (only when this module created the zone)."
  value       = var.create_route53_zone ? aws_route53_zone.this[0].name_servers : []
}

output "site_url" {
  value = "https://${var.domain_name}"
}

output "metadata_table" {
  description = "DynamoDB table for image metadata (geo-tags, descriptions)."
  value       = aws_dynamodb_table.images.name
}
