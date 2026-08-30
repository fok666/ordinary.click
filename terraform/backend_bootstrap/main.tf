terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "aws_region" {
  description = "AWS region for Terraform state storage."
  type        = string
  default     = "eu-west-1"
}

variable "project" {
  description = "Project name prefix."
  type        = string
  default     = "ordinary-click"
}

provider "aws" {
  region = var.aws_region
}

# ---------------------------------------------------------------------------
# S3 bucket for Terraform remote state
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "tfstate" {
  bucket = "${var.project}-tfstate"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------------------
# DynamoDB table for Terraform state locking
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table" "tflock" {
  name         = "${var.project}-tflock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  lifecycle {
    prevent_destroy = true
  }
}

output "tfstate_bucket_name" {
  description = "S3 bucket for remote state."
  value       = aws_s3_bucket.tfstate.id
}

output "tflock_table_name" {
  description = "DynamoDB table for state locking."
  value       = aws_dynamodb_table.tflock.name
}
