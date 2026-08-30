# Complete Beginner Deployment & Setup Guide — ordinary.click

This guide walks you through deploying **ordinary.click** from scratch to AWS. Every step is explained in plain language, from purchasing a domain to deploying automated serverless infrastructure, enabling AI auto-tagging, and configuring zero-secret GitHub Actions CI/CD.

---

## Architecture at a Glance

```text
                                ┌──────────────────────────┐
         browser ──HTTPS──▶     │   CloudFront (TLS, edge) │
                                └──────────┬───────────────┘
                                           │
                  ┌────────────────────────┼─────────────────────────┐
                  │ default                │ /images/* /thumbs/*     │ /api/*
                  ▼                        ▼                         ▼
         ┌────────────────┐       ┌─────────────────┐      ┌────────────────────┐
         │ S3: site (OAC) │       │ S3: images (OAC)│      │ API Gateway HTTP   │
         │ index.html, JS │       │ originals/      │      │  ↓ AWS_PROXY       │
         └────────────────┘       │ display/ thumbs/│      │ API Lambda (py3.14)│
                                  └───┬─────────▲───┘      └──────────┬─────────┘
                        S3 event on   │         │ writes              │
                        originals/*   ▼         │ derivatives         ▼
                                  ┌─────────────┴───┐      ┌────────────────────┐
                                  │ processor Lambda│─────▶│ DynamoDB catalog   │
                                  │ (Pillow, AI)    │ mark │ photos+collections │
                                  └────────┬────────┘ ready└────────────────────┘
                                           │ optional
                                           ▼
                                  ┌─────────────────┐
                                  │ AWS Rekognition │ (auto-labels)
                                  └─────────────────┘
```

- **Scale-to-zero**: When no one visits or uploads, AWS charges $0.00 for computing.
- **No long-lived AWS keys**: GitHub Actions authenticates with AWS via OpenID Connect (OIDC).
- **Private buckets**: S3 buckets are completely private; only CloudFront accesses them via Origin Access Control (OAC).

---

## 1. Prerequisites & Tooling

Install the following tools on your local machine:

1. **AWS CLI v2**:
   ```bash
   aws --version
   aws configure   # enter your AWS Access Key, Secret, and default region (e.g. eu-west-1)
   ```
2. **Terraform** (>= 1.6.0):
   ```bash
   terraform -version
   ```
3. **Python 3.12+** & **pip**:
   ```bash
   python3 --version
   ```
4. **Node.js 20+** (for running local frontend tests):
   ```bash
   node --version
   ```
5. **A Domain Name**:
   - You can buy one directly via **AWS Route 53 Domains**, or use an external registrar (**Cloudflare**, **Namecheap**, **Porkbun**, etc.).

---

## 2. Step-by-Step Deployment Walkthrough

### Step 1: DNS & Domain Setup

Decide where your DNS hosted zone lives:

- **Option A: Route 53 Managed (Easiest)**
  If you bought your domain on Route 53 or delegated nameservers to Route 53:
  Set `create_route53_zone = true` in `terraform.tfvars`. Terraform will create the public hosted zone and automatically configure DNS validation records for your SSL/TLS certificates.

- **Option B: External DNS (Cloudflare, Namecheap, etc.)**
  Set `create_route53_zone = false`. Terraform will output the ACM certificate DNS validation records (`acm_certificate_validation_records`). Copy the `CNAME` name and value into your external DNS dashboard to prove domain ownership.

---

### Step 2: Terraform State Backend (Optional but Recommended)

For personal development, Terraform saves state locally in `terraform.tfstate`. To store state safely in the cloud with concurrent run locking:

1. Run the bootstrap script:
   ```bash
   AWS_REGION=eu-west-1 scripts/bootstrap-tf-backend.sh
   ```
   Or use the included Terraform module:
   ```bash
   cd terraform/backend_bootstrap
   terraform init && terraform apply
   ```

2. Copy the example backend configuration:
   ```bash
   cp terraform/backend.hcl.example terraform/backend.hcl
   ```
   Update the bucket name and region in `terraform/backend.hcl` if you customized them.

---

### Step 3: Configure & Deploy Infrastructure

1. Navigate to the `terraform/` directory:
   ```bash
   cd terraform
   ```

2. Create a `terraform.tfvars` file:
   ```hcl
   domain_name               = "yourdomain.com"
   subject_alternative_names = ["www.yourdomain.com"]
   github_repository         = "yourusername/ordinary.click"
   aws_region                = "eu-west-1"

   # DNS configuration
   create_route53_zone       = true   # true if Route 53 manages the zone

   # Optional AI auto-tagging (AWS Rekognition)
   rekognition_enabled        = true
   rekognition_min_confidence = 80.0
   rekognition_max_labels     = 5
   rekognition_auto_merge     = false  # true to auto-add AI tags, false for admin approval
   ```

3. Initialize Terraform:
   ```bash
   # If using remote state:
   terraform init -backend-config=backend.hcl

   # Or if using local state:
   terraform init
   ```

4. Review and apply the infrastructure plan:
   ```bash
   terraform plan -out=tfplan
   terraform apply tfplan
   ```

> **Note on initial apply duration**: CloudFront distributions and ACM certificates take about 3 to 5 minutes to provision and deploy to all edge locations globally.

---

### Step 4: Create Your Admin Account (Cognito)

Public registration is disabled by design. To create your administrator account:

1. Note the `cognito_user_pool_id` printed in Terraform outputs:
   ```bash
   terraform output cognito_user_pool_id
   ```

2. Create your admin user with the AWS CLI:
   ```bash
   aws cognito-idp admin-create-user \
     --user-pool-id "<COGNITO_USER_POOL_ID>" \
     --username "your-email@example.com" \
     --user-attributes Name=email,Value="your-email@example.com" Name=email_verified,Value=true \
     --message-action SUPPRESS
   ```

3. Set a permanent password:
   ```bash
   aws cognito-idp admin-set-user-password \
     --user-pool-id "<COGNITO_USER_POOL_ID>" \
     --username "your-email@example.com" \
     --password "YourSecurePassword123!" \
     --permanent
   ```

4. Open your website in a browser, click **Sign in** in the top navigation, and enter your credentials. You now have full admin privileges (uploading, tag editing, collections, AI tag approvals).

---

### Step 5: Configure GitHub Actions CI/CD (OIDC)

ordinary.click uses GitHub Actions OIDC federation, meaning **no AWS Secret Keys are ever stored in GitHub**.

In your GitHub repository settings (**Settings > Secrets and variables > Actions > Variables** tab), add:

| Variable Name | Description | Source |
|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | IAM role assumed by GitHub Actions | Terraform output `github_deployer_role_arn` |
| `CLOUDFRONT_DISTRIBUTION_ID` | CloudFront Distribution ID for edge cache invalidations | Terraform output `cloudfront_distribution_id` |
| `TF_STATE_BUCKET` *(optional)* | S3 bucket name for Terraform remote state | e.g. `ordinary-click-tfstate` |
| `TF_LOCK_TABLE` *(optional)* | DynamoDB lock table name | e.g. `ordinary-click-tflock` |

Once set:
- Any Pull Request automatically runs the **CI Suite** (`./test.sh`, Python tests, and `terraform fmt/validate`).
- Merging to `main` automatically syncs the `site/` files to S3 and invalidates the CloudFront cache.
- The `terraform.yml` workflow can run `terraform plan` on PRs and `terraform apply` when infrastructure code changes.

---

## 3. AI Auto-Tagging with AWS Rekognition

### How It Works
When you upload a photo:
1. The **Processor Lambda** generates high-quality display and thumbnail images using Pillow.
2. If `rekognition_enabled = true`, it calls `rekognition:DetectLabels` on the display image bytes.
3. Labels exceeding `rekognition_min_confidence` (e.g. 80%) are normalized into valid tags (e.g. "Mountain Peak" → `mountain-peak`).
4. Labels are stored in DynamoDB under the `ai_tags` attribute.

### Approving AI Suggestions
In the photo editing modal (`✏️`):
- AI suggestions appear in the **✨ AI Suggestions (Rekognition)** section.
- Click any tag to add it to your photo's tags.
- Click **+ Add all** to accept all suggestions, or **Dismiss** to discard them.
- If you prefer fully automatic tagging without manual approval, set `rekognition_auto_merge = true` in `terraform.tfvars`.

### AWS Cost & Free Tier
- **AWS Free Tier** includes **5,000 image analyses per month** for the first 12 months.
- Beyond the free tier, Rekognition costs **$0.001 per image** (1,000 photos = $1.00).

---

## 4. Local Development (Offline & Instant)

You can run and test the complete gallery offline with zero AWS dependencies:

```bash
# Start the local development server (serves site/ and mock API)
python3 scripts/dev-server.py 8000

# Open in your browser:
open http://localhost:8000
```

- Click **Admin Mode** in the header or visit `http://localhost:8000/api/dev/auth` to simulate admin permissions locally.
- Test drag-and-drop uploads, instant search, 3D tag cloud, and AI tag suggestions offline.

To run all automated test suites:
```bash
./test.sh
```

---

## 5. Troubleshooting & FAQ

### CloudFront returns 403 Forbidden on images or site
- **Cause**: CloudFront Origin Access Control (OAC) policy has not propagated or S3 bucket policy is blocking the distribution.
- **Fix**: Verify that the S3 bucket policy allows `s3:GetObject` for `Service: cloudfront.amazonaws.com` matching your distribution's ARN. Terraform manages this automatically, but if you modified the S3 bucket manually, re-run `terraform apply`.

### Changes to `index.html` or `styles.css` are not appearing
- **Cause**: CloudFront caches static HTML/CSS files at edge locations.
- **Fix**: Invalidate the cache manually:
  ```bash
  aws cloudfront create-invalidation \
    --distribution-id "<DISTRIBUTION_ID>" \
    --paths "/*"
  ```
  The GitHub Actions deploy workflow runs this invalidation automatically on every push.

### Cognito Hosted UI returns "redirect_mismatch"
- **Cause**: The callback URL in Cognito does not exactly match the URL in your browser.
- **Fix**: In `terraform/cognito.tf`, the callback URL is configured as `https://${var.domain_name}/`. Ensure you are visiting `https://yourdomain.com/` and not `http://` or an unconfigured subdomain. Trailing slashes matter.

### API Gateway returns 401 Unauthorized for admin actions
- **Cause**: The JWT token in `localStorage` expired or was issued by a different Cognito User Pool.
- **Fix**: Click **Sign out** and log in again through the Cognito hosted UI. Tokens are valid for 60 minutes.

### Processor Lambda times out on large uploads
- **Cause**: Very high-resolution raw photos (e.g. 48MP+) take more memory and CPU for Pillow to downscale.
- **Fix**: In `terraform.tfvars`, increase processor memory:
  ```hcl
  processor_memory_mb = 1536   # increases available CPU proportionally
  ```

---

## 6. Cleanup / Teardown

If you ever wish to destroy all deployed AWS resources and return to zero cost:

```bash
# 1. Empty S3 buckets (AWS prohibits deleting non-empty buckets)
aws s3 rm "s3://ordinary-click-images" --recursive
aws s3 rm "s3://ordinary-click-site" --recursive

# 2. Destroy infrastructure via Terraform
cd terraform
terraform destroy
```
