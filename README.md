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

Upload images under the `categories/<category-name>/` prefix in the
`ordinary-click-images` bucket. Filenames become the displayed images; the
first object in a category is used as its cover.

```bash
aws s3 cp ./mountains/ "s3://ordinary-click-images/categories/mountains/" \
  --recursive --content-type image/jpeg
```

The API caches category listings for 60 seconds at the edge.

## Cost notes

* CloudFront `PriceClass_100` keeps egress costs low (NA + EU edges only).
* Lambda is ARM64 with 256 MB — cheapest tier with usable cold starts.
* S3 lifecycle rule expires non-current site object versions after 30 days.
* Logs are retained for 14 days by default (override `lambda_log_retention_days`).
