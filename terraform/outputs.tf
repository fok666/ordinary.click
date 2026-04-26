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

output "lambda_function_url" {
  description = "Direct Function URL of the gallery API (CloudFront fronts it at /api/*)."
  value       = aws_lambda_function_url.api.function_url
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
