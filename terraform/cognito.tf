################################################################################
# Cognito user pool — backs the management/admin login on the gallery site.
#
# Self-signup is disabled: only an administrator (you) creates users via the
# Cognito console or CLI. The hosted UI handles login + password resets, and
# API Gateway validates the issued JWT before any /api/admin/* request reaches
# the Lambda.
################################################################################

resource "aws_cognito_user_pool" "admins" {
  name                     = "${local.project}-admins"
  deletion_protection      = "ACTIVE"
  mfa_configuration        = "OFF"
  auto_verified_attributes = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  username_attributes = ["email"]

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 3
      max_length = 256
    }
  }
}

# Hosted UI domain (Cognito-hosted, no custom certificate to avoid extra cost).
resource "random_string" "cognito_domain_suffix" {
  length  = 6
  upper   = false
  numeric = true
  special = false
}

resource "aws_cognito_user_pool_domain" "admins" {
  domain       = "${local.project}-${random_string.cognito_domain_suffix.result}"
  user_pool_id = aws_cognito_user_pool.admins.id
}

resource "aws_cognito_user_pool_client" "site" {
  name         = "${local.project}-site"
  user_pool_id = aws_cognito_user_pool.admins.id

  generate_secret                      = false
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = [for h in local.all_aliases : "https://${h}/"]
  logout_urls   = [for h in local.all_aliases : "https://${h}/"]

  # Hosted UI uses authorization-code + PKCE in the browser — no client secret.
  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  access_token_validity  = 60   # minutes
  id_token_validity      = 60   # minutes
  refresh_token_validity = 30   # days
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

locals {
  cognito_issuer        = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.admins.id}"
  cognito_hosted_domain = "${aws_cognito_user_pool_domain.admins.domain}.auth.${var.aws_region}.amazoncognito.com"
}
