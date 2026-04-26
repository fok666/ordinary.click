# ordinary.click

A scale-to-zero personal image gallery hosted on AWS at
[ordinary.click](https://ordinary.click). All infrastructure is defined in
Terraform; the site and API deploy from this repo.

## Architecture

```
                          ┌──────────────────────────┐
   browser ──HTTPS──▶     │   CloudFront (TLS, edge) │
                          └──────────┬───────────────┘
                                     │
            ┌────────────────────────┼─────────────────────────┐
            │ default                │ /images/*               │ /api/*
            ▼                        ▼                         ▼
   ┌────────────────┐       ┌────────────────┐       ┌────────────────────┐
   │ S3: site (OAC) │       │ S3: images(OAC)│       │ API Gateway HTTP   │
   │ index.html, JS │       │ photos by      │       │  ↓ AWS_PROXY       │
   └────────────────┘       │ category/      │       │ Lambda (py3.12,arm)│
                            └────────────────┘       └────────────────────┘
```

* **Scale-to-zero**: nothing runs while idle. S3 charges per byte stored,
  CloudFront per request, API Gateway + Lambda per invocation. No EC2, no
  NAT, no ALB.
* **Fast**: HTML/CSS/JS and images are served from CloudFront edges. The
  API is a single ARM64 Python Lambda behind an API Gateway HTTP API, fronted
  by CloudFront with a 60s cache, so most requests never reach Lambda.
* **Self-contained**: the repo holds Terraform (`terraform/`), the API code
  (`lambda/api/`), the static site (`site/`), and a GitHub Actions workflow
  (`.github/workflows/deploy.yml`) that uses OIDC — no long-lived AWS keys.

> **Why API Gateway and not a Lambda Function URL with CloudFront OAC?**
> The textbook AWS pattern is CloudFront OAC → Lambda Function URL
> (`AuthType=AWS_IAM`). In some AWS Organizations a guardrail blocks all
> non-IAM-principal access to Lambda Function URLs (including the
> `cloudfront.amazonaws.com` service principal used by OAC and unauthenticated
> `Principal:"*"` on `AuthType=NONE`). When that's the case, every CloudFront
> → Lambda URL request returns `403 AccessDeniedException` regardless of
> resource-policy configuration. API Gateway HTTP API invokes Lambda via the
> integration's IAM principal, which is not subject to that guardrail and
> costs ~$1/M requests (1M/month free tier).

## Layout

| Path | Purpose |
| --- | --- |
| `terraform/` | All AWS infrastructure (S3, CloudFront, ACM, Route53, Lambda, IAM, GitHub OIDC). |
| `lambda/api/` | Python 3.12 Lambda that lists categories & images from S3. |
| `site/` | Static front-end deployed to the site bucket. |
| `.github/workflows/deploy.yml` | OIDC-based deploy pipeline. |

## Bootstrap

```bash
cd terraform
terraform init
terraform apply \
  -var 'github_repository=<owner>/<repo>'
```

After the first apply:

1. Point `ordinary.click` at the AWS name servers printed in
   `route53_name_servers` (skip if you set `create_route53_zone=false`).
2. In GitHub, add two **Repository variables**:
   * `AWS_DEPLOY_ROLE_ARN` — value of the `github_deployer_role_arn` output.
   * `CLOUDFRONT_DISTRIBUTION_ID` — value of the `cloudfront_distribution_id` output.
3. Push to `main`. The workflow syncs `site/` to S3 and invalidates CloudFront.

## Adding photos

Two ways to upload:

### From the website (recommended)

1. Click **Sign in** in the top-right and authenticate via the Cognito hosted
   UI. Sign-up is disabled — accounts are created by an administrator (you).
   Create the first user once, after `terraform apply`:

   ```bash
   POOL_ID=$(terraform -chdir=terraform output -raw cognito_user_pool_id)
   aws cognito-idp admin-create-user \
     --user-pool-id "$POOL_ID" \
     --username you@example.com \
     --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
   ```

   Cognito emails a temporary password; you'll be asked to change it on first
   login.

2. On the home page, an **Upload** form appears. Type a category name (new or
   existing) and pick image files. Each upload is sent directly to S3 via a
   presigned POST. The processor Lambda then produces a max-2048px display
   image and a max-400px thumbnail; the original is kept untouched.

3. On a category page, you can upload more images and click the trash icon on
   any tile to delete it (original + display + thumb together).

### From the CLI (legacy / bulk)

Direct uploads under `categories/<name>/` still work for the read API but
won't get a thumbnail or be down-scaled, so the gallery falls back to the
display URL for the cover. To trigger processing, upload to the
`originals/<name>/` prefix instead:

```bash
aws s3 cp ./mountains/ "s3://ordinary-click-images/originals/mountains/" \
  --recursive
```

S3 layout:

| Prefix | Contents | Public path |
| --- | --- | --- |
| `originals/<cat>/<file>` | uploaded original (kept) | _private_ |
| `categories/<cat>/<file>` | display image (≤ 2048 px long edge) | `/images/<cat>/<file>` |
| `thumbs/<cat>/<file>` | thumbnail (≤ 400 px long edge) | `/thumbs/<cat>/<file>` |

The API caches category listings for 60 seconds at the edge.

## Click for full-size view

The gallery view opens a lightbox when you click a thumbnail. Use the on-
screen arrows or `←`/`→` to step through images, and `Esc` (or click the
backdrop) to close.

## Cost notes

* CloudFront `PriceClass_100` keeps egress costs low (NA + EU edges only).
* Lambda is ARM64 with 256 MB — cheapest tier with usable cold starts.
* S3 lifecycle rule expires non-current site object versions after 30 days.
* Logs are retained for 14 days by default (override `lambda_log_retention_days`).
