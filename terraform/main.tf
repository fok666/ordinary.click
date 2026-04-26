locals {
  project = "ordinary-click"

  common_tags = merge({
    Project   = local.project
    ManagedBy = "terraform"
    Domain    = var.domain_name
  }, var.tags)

  all_aliases = concat([var.domain_name], var.subject_alternative_names)
}

data "aws_caller_identity" "current" {}
