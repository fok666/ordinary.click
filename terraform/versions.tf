terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      # 6.x required: the 5.x provider validates aws_lambda_function.runtime
      # against a hardcoded list that stops at python3.13.
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }

  # Configure a remote backend before running in production.
  # backend "s3" {
  #   bucket         = "ordinary-click-tfstate"
  #   key            = "infra/terraform.tfstate"
  #   region         = "eu-central-1"
  #   dynamodb_table = "ordinary-click-tflock"
  #   encrypt        = true
  # }
}
