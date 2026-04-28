#!/bin/bash

# This script is used to set the AWS credentials as environment variables.
CREDENTIALS=$(aws sts assume-role --role-arn arn:aws:iam::511637446646:role/AssumeAdminRole --role-session-name "terraform" --profile fok666)

# Read the AWS credentials from the assumed role
export AWS_ACCESS_KEY_ID=$(echo "$CREDENTIALS" | jq -r '.Credentials.AccessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDENTIALS" | jq -r '.Credentials.SecretAccessKey')
export AWS_SESSION_TOKEN=$(echo "$CREDENTIALS" | jq -r '.Credentials.SessionToken')
