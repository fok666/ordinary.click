# Example Terraform S3 remote backend configuration
# Usage:
#   terraform init -backend-config=backend.hcl
#
# Ensure the S3 bucket and DynamoDB lock table exist first (see terraform/backend_bootstrap/
# or scripts/bootstrap-tf-backend.sh).

bucket         = "ordinary-click-tfstate"
key            = "infra/terraform.tfstate"
region         = "eu-west-1"
dynamodb_table = "ordinary-click-tflock"
encrypt        = true
