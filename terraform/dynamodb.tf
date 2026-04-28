################################################################################
# DynamoDB table for image metadata (geo-tags, descriptions).
################################################################################

resource "aws_dynamodb_table" "images" {
  name         = "${local.project}-images"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "category"
  range_key    = "filename"

  attribute {
    name = "category"
    type = "S"
  }

  attribute {
    name = "filename"
    type = "S"
  }

  tags = local.common_tags
}
