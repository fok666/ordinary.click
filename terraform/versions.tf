terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
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
