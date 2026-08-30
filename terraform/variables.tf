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

variable "rekognition_enabled" {
  description = "Enable AWS Rekognition auto-tagging for newly uploaded images."
  type        = bool
  default     = false
}

variable "rekognition_min_confidence" {
  description = "Minimum confidence threshold (0-100) for Rekognition label detection."
  type        = number
  default     = 80.0
}

variable "rekognition_max_labels" {
  description = "Maximum number of Rekognition labels to extract per photo."
  type        = number
  default     = 5
}

variable "rekognition_auto_merge" {
  description = "If true, automatically merges Rekognition labels into stored categories."
  type        = bool
  default     = false
}

variable "display_max_px" {
  description = "Maximum bounding edge in pixels for generated display derivatives. Directly impacts display image file sizes and bandwidth."
  type        = number
  default     = 2048
}

variable "thumb_max_px" {
  description = "Maximum bounding edge in pixels for gallery thumbnails. Determines initial grid load weight."
  type        = number
  default     = 400
}

variable "jpeg_quality" {
  description = "JPEG compression quality factor (1-100). 85 provides near-lossless visual quality with ~40% file size reduction over 95."
  type        = number
  default     = 85
}

variable "s3_originals_glacier_days" {
  description = "Days before transitioning raw originals/ images to S3 Glacier Instant Retrieval (GLACIER_IR). Reduces raw storage costs by ~80%."
  type        = number
  default     = 30
}

variable "s3_abort_multipart_days" {
  description = "Days after which incomplete multipart uploads in the image bucket are automatically aborted. Prevents hidden billing leaks from abandoned browser uploads."
  type        = number
  default     = 7
}

