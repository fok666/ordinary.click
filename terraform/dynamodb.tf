################################################################################
# DynamoDB catalog table — single-table store for the tag-based model.
#
#   Photo       pk="PHOTO"       sk=<id>            (id = sha256 hex of bytes)
#   Collection  pk="COLLECTION"  sk=<collectionId>
#
# All category membership (a string set), collection membership, descriptions
# and geo-tags live here. S3 only holds the image bytes.
################################################################################

resource "aws_dynamodb_table" "catalog" {
  name         = "${local.project}-catalog"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  tags = local.common_tags
}
