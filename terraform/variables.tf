variable "aws_region" {
  description = "Primary AWS region for regional resources (S3, Lambda)."
  type        = string
  default     = "eu-west-1"
}

variable "domain_name" {
  description = "Apex domain served by CloudFront."
  type        = string
  default     = "ordinary.click"
}

variable "subject_alternative_names" {
  description = "Extra hostnames to attach to the TLS cert and CloudFront distribution."
  type        = list(string)
  default     = ["www.ordinary.click"]
}

variable "create_route53_zone" {
  description = "If true, Terraform creates the public hosted zone. Set false if the zone already exists."
  type        = bool
  default     = false
}

variable "github_repository" {
  description = "GitHub repo allowed to assume the deployer role, formatted as owner/repo."
  type        = string
  default     = "fok666/ordinary.click"
}

variable "github_deploy_branches" {
  description = "Git refs allowed to deploy (used in the OIDC trust policy sub claim)."
  type        = list(string)
  default     = ["refs/heads/main"]
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 is cheapest (NA + EU edges)."
  type        = string
  default     = "PriceClass_100"
}

variable "lambda_memory_mb" {
  description = "Memory for the gallery API Lambda. Higher memory = more CPU = faster cold starts."
  type        = number
  default     = 256
}

variable "processor_memory_mb" {
  description = "Memory for the image processor Lambda. Pillow benefits from more CPU; 1024 MB is a good cost/perf sweet spot."
  type        = number
  default     = 1024
}

variable "lambda_log_retention_days" {
  description = "CloudWatch log retention for the API Lambda."
  type        = number
  default     = 14
}

variable "tags" {
  description = "Extra tags to merge into every resource."
  type        = map(string)
  default     = {}
}
