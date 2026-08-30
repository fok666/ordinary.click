#!/usr/bin/env bash
# Bootstrap S3 Bucket and DynamoDB Lock Table for Terraform Remote State
set -euo pipefail

REGION="${AWS_REGION:-eu-west-1}"
PROJECT="${PROJECT_NAME:-ordinary-click}"
BUCKET_NAME="${PROJECT}-tfstate"
TABLE_NAME="${PROJECT}-tflock"

echo "Bootstrapping Terraform remote backend in region: ${REGION}..."

# 1. Create S3 Bucket
if aws s3api head-bucket --bucket "${BUCKET_NAME}" 2>/dev/null; then
    echo "  S3 bucket ${BUCKET_NAME} already exists."
else
    echo "  Creating S3 bucket ${BUCKET_NAME}..."
    if [ "${REGION}" = "us-east-1" ]; then
        aws s3api create-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
    else
        aws s3api create-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" \
            --create-bucket-configuration LocationConstraint="${REGION}"
    fi
fi

# Enable versioning
echo "  Enabling S3 bucket versioning..."
aws s3api put-bucket-versioning --bucket "${BUCKET_NAME}" \
    --versioning-configuration Status=Enabled

# Enable default encryption (AES256)
echo "  Enabling S3 bucket encryption..."
aws s3api put-bucket-encryption --bucket "${BUCKET_NAME}" \
    --server-side-encryption-configuration '{
        "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]
    }'

# Block public access
echo "  Enabling S3 block public access..."
aws s3api put-public-access-block --bucket "${BUCKET_NAME}" \
    --public-access-block-configuration '{
        "BlockPublicAcls": true,
        "IgnorePublicAcls": true,
        "BlockPublicPolicy": true,
        "RestrictPublicBuckets": true
    }'

# 2. Create DynamoDB Table for locking
if aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    echo "  DynamoDB table ${TABLE_NAME} already exists."
else
    echo "  Creating DynamoDB table ${TABLE_NAME}..."
    aws dynamodb create-table \
        --table-name "${TABLE_NAME}" \
        --attribute-definitions AttributeName=LockID,AttributeType=S \
        --key-schema AttributeName=LockID,KeyType=HASH \
        --billing-mode PAY_PER_REQUEST \
        --region "${REGION}" >/dev/null
fi

echo ""
echo "Done! You can now configure your Terraform backend:"
echo "  bucket         = \"${BUCKET_NAME}\""
echo "  key            = \"infra/terraform.tfstate\""
echo "  region         = \"${REGION}\""
echo "  dynamodb_table = \"${TABLE_NAME}\""
echo "  encrypt        = true"
