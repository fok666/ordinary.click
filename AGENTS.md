# Project Guidelines — ordinary.click

Serverless personal photo gallery on AWS. Scale-to-zero: CloudFront → S3 + API Gateway + Lambda + Cognito + DynamoDB. See [README.md](README.md) for architecture diagram and full docs.

## Tech Stack

- **Infrastructure**: Terraform >= 1.6.0, AWS provider ~> 5.60
- **Backend**: Python 3.12 on Lambda (ARM64), Pillow 10.4.0 for image processing
- **Frontend**: Vanilla ES6+ JavaScript, Leaflet 1.9.4 (CDN), no bundler
- **Auth**: Cognito with PKCE authorization code flow, JWTs validated at API Gateway
- **CI/CD**: GitHub Actions with OIDC federation (no long-lived AWS keys)

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `terraform/` | All AWS infrastructure as code |
| `lambda/api/` | Gallery API Lambda — categories, images, presigned URLs |
| `lambda/processor/` | Image processor Lambda — resize, thumbnails, GPS extraction (S3-triggered) |
| `site/` | Static SPA (HTML/CSS/JS), deployed to S3 via `aws s3 sync` |
| `scripts/` | Local helper scripts (e.g., STS assume-role) |
| `terraform/build/` | Generated build artifacts for Lambda (gitignored) |

## Build & Deploy

```bash
# Infrastructure
cd terraform && terraform init && terraform apply

# Lambda processor dependencies (auto-run by Terraform local-exec)
python3 -m pip install --target terraform/build/processor \
  --platform manylinux2014_aarch64 --implementation cp \
  --python-version 3.12 --only-binary=:all: \
  -r lambda/processor/requirements.txt

# Site deployment (done by GitHub Actions)
aws s3 sync site/ s3://<site-bucket>/ --delete
aws cloudfront create-invalidation --distribution-id <id> --paths "/*"
```

There are no automated tests. No linting is configured.

## Code Conventions

### Python (Lambdas)

- Single `handler(event, context)` entry point per `handler.py`
- Module-level logger: `LOG = logging.getLogger()`
- Validate inputs with regex patterns (`_NAME_RE`, `_FILE_RE`) — never trust API Gateway alone
- Use `decimal.Decimal` for DynamoDB float values
- Config via environment variables (`IMAGE_BUCKET`, `METADATA_TABLE`, etc.) — no `.env` files
- Graceful degradation: log errors, return useful responses, don't crash on optional metadata

### JavaScript (Frontend)

- No build step, no transpilation, no framework
- Hash-based routing (`#/`, `#/gallery`, `#/c/<category>`, `#/map`)
- Always escape user content with the `esc()` helper to prevent XSS
- Use `fetchJSON()` / `fetchAuthed()` wrappers for API calls
- Auth tokens in `localStorage`; PKCE implemented manually per RFC 7636

### Terraform

- Project name is `ordinary-click` in locals, referenced everywhere
- Use `data.aws_iam_policy_document` for IAM policies (not inline JSON)
- Multi-region via provider aliasing (`aws.us_east_1` for CloudFront/ACM)
- Conditional resources with `count`
- Common tags applied via `local.common_tags`

## S3 Layout (Images Bucket)

```
originals/<category>/<file>    # User uploads (kept forever)
categories/<category>/<file>   # Display size (≤ 2048px)
thumbs/<category>/<file>       # Thumbnails (≤ 400px)
```

## API Endpoints

- `GET /api/categories`, `GET /api/categories/<name>`, `GET /api/geo` — public, 60s CloudFront cache
- `POST/PUT/DELETE /api/admin/*` — Cognito JWT required
- Category and filename params are regex-validated server-side

## Security Notes

- No secrets in code — OIDC for CI, IAM roles for Lambdas
- S3 buckets use OAC (no public access), encryption at rest
- Cognito self-signup is disabled; admin-created users only
- CloudFront enforces security headers (X-Content-Type-Options, X-Frame-Options, etc.)
