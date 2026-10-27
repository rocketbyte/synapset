# Setting up an environment

From an empty Google Cloud project to a working, deployed API. Replace `dev` with your environment name (`prod`, …) throughout. The default setup has no fixed monthly cost (see the README's "Cost profile").

Prerequisites: `gcloud`, Terraform ≥ 1.9, Node 24 with pnpm 10, a GitHub repository for this code, and an Anthropic account.

## 1. Create the Google Cloud project

Use a dedicated project per environment so costs, IAM and quotas stay isolated.

```sh
export PROJECT_ID=synapset-dev            # globally unique
export REGION=us-central1

gcloud projects create "$PROJECT_ID"
gcloud billing accounts list                # note the ACCOUNT_ID
gcloud billing projects link "$PROJECT_ID" --billing-account=<ACCOUNT_ID>
gcloud config set project "$PROJECT_ID"

# Terraform enables everything else; these two are needed to let it do so.
gcloud services enable cloudresourcemanager.googleapis.com serviceusage.googleapis.com

gcloud auth login
gcloud auth application-default login       # credentials for Terraform and the admin CLI
```

## 2. Create the Terraform state bucket

```sh
gcloud storage buckets create "gs://$PROJECT_ID-tfstate" --location="$REGION" \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://$PROJECT_ID-tfstate" --versioning
```

Terraform state contains secrets (the Redis AUTH string, when Redis is enabled). Only operators should have access to this bucket.

## 3. Get an Anthropic API key

1. In the [Anthropic Console](https://console.anthropic.com), create an API key for this environment.
2. Under **Settings → Limits**, set a monthly spend limit. This is the backstop behind `LLM_DAILY_BUDGET_USD`.

## 4. Configure Terraform

```sh
cd infra/terraform
cp dev.tfvars.example dev.tfvars
```

Edit `dev.tfvars`:

```hcl
project_id           = "synapset-dev"
environment          = "dev"
region               = "us-central1"
github_repository    = "<owner>/<repo>"      # only this repo's main branch may deploy
llm_daily_budget_usd = 5                     # hard daily cap on LLM spend

# Recommended, no fixed cost:
alert_email          = "you@example.com"     # budget exhausted, failover, lost usage, dead letters, 5xx
billing_account_id   = "<ACCOUNT_ID>"        # monthly GCP budget alerts at 50/90/100%
monthly_budget_usd   = 50

# Optional, fixed cost (leave off at low traffic):
# redis_enabled = true                       # ~$36/month
# api_domain    = "api.example.com"          # ~$34/month (load balancer + Cloud Armor)
```

The billing budget requires the Billing Account Administrator or Billing Account Costs Manager role on the billing account.

## 5. Create the infrastructure

```sh
terraform init -backend-config="bucket=$PROJECT_ID-tfstate" -backend-config="prefix=dev"

# First the Anthropic secret, so its value exists before the worker starts.
terraform apply -var-file=dev.tfvars -target=google_secret_manager_secret.anthropic_api_key
printf '%s' '<ANTHROPIC_API_KEY>' | gcloud secrets versions add synapset-dev-anthropic-api-key --data-file=-

terraform apply -var-file=dev.tfvars
terraform output
```

Notes:

- The Cloud Run services start with a placeholder image. CI replaces it with the real images in step 7.
- The Firestore vector index takes a few minutes to build. Check with `gcloud firestore indexes composite list`.
- If you set `alert_email`, confirm the verification email Google sends.

## 6. Configure GitHub

Create a GitHub Environment named exactly like the Terraform `environment` (**Settings → Environments → New environment → `dev`**). The deploy identity only accepts jobs that run in that environment on `main`. Add these **environment variables** to it:

| Variable                     | Value                                              |
| ---------------------------- | -------------------------------------------------- |
| `GCP_REGION`                 | `us-central1`                                      |
| `ARTIFACT_REGISTRY`          | `terraform output -raw artifact_registry`          |
| `WORKLOAD_IDENTITY_PROVIDER` | `terraform output -raw workload_identity_provider` |
| `DEPLOYER_SERVICE_ACCOUNT`   | `terraform output -raw deployer_service_account`   |

No GCP keys are stored in GitHub: deploys authenticate through Workload Identity Federation.

Recommended:

- protect `main` and require the CI checks;
- enable Dependabot alerts and secret scanning (**Settings → Code security**). Secret scanning catches leaked `synapset_sk_` keys.

## 7. Deploy

```sh
git add -A && git commit -m "Initial Synapset service"
git push origin main
```

CI runs format, lint, typecheck, tests (with Redis and the Firestore emulator), Terraform validation and the Docker builds. When CI passes on `main`, the Deploy workflow builds both images, pushes them to Artifact Registry and rolls them out to Cloud Run.

## 8. Create an account and an API key

The admin CLI talks to Firestore directly, using your gcloud credentials.

```sh
export GCP_PROJECT_ID=$PROJECT_ID
pnpm admin account create --name "Internal test" --plan free          # prints acct_…
pnpm admin key create --account <acct_…> --name smoke-test            # prints the key once
export KEY=<printed key>
```

## 9. Verify end to end

```sh
API=$(cd infra/terraform && terraform output -raw api_url)

curl -s "$API/health"                                                   # {"status":"ok"}
curl -s -i "$API/v1/usage"                                               # 401 problem+json
curl -s "$API/v1/usage" -H "Authorization: Bearer $KEY"

# Cache miss: 202 with a job.
curl -s -i "$API/v1/assessments" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"topic":"Rust ownership"}'

# Poll until "done" (usually 10-60 s), then fetch the assessment by its assessmentId.
curl -s "$API/v1/jobs/<jobId>" -H "Authorization: Bearer $KEY"
curl -s "$API/v1/assessments/<assessmentId>" -H "Authorization: Bearer $KEY"

# Same topic again: 200, match "exact". A paraphrase ("ownership in Rust"): 200, match "semantic".
curl -s "$API/v1/assessments" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"topic":"ownership in Rust"}'
```

Then check each part of the pipeline:

| Check            | Where                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Worker generated | Cloud Run → `synapset-dev-worker` logs: `Assessment generated` with tokens and `costUsd`     |
| Spend recorded   | Firestore → `limits` → `spend:<today>` (micro-USD)                                           |
| Usage metered    | BigQuery: `SELECT * FROM synapset_dev_usage.usage_events ORDER BY occurred_at DESC LIMIT 20` |
| Nothing stuck    | Pub/Sub → `assessment-generate-v1-dlq-inspect` and `usage-events-v1-dlq-inspect` are empty   |
| Limits work      | Repeat `/v1/usage` quickly: `RateLimit-Remaining` drops, then you get 429 with `Retry-After` |

If a job fails, `GET /v1/jobs/<id>` shows the error code and the worker log shows the reason.

## 10. Before onboarding customers

- Check `MODEL_PRICES` in `packages/core/src/billing.ts` against current Anthropic and Google pricing. The spend cap is only as accurate as this table.
- Create real accounts with the right plans and give each customer its own key:

  ```sh
  pnpm admin account create --name "Acme" --plan pro
  pnpm admin key create --account <acct> --name production --scopes assessments:read,assessments:write --expires-days 365
  ```

- Rotate keys by creating a new key, switching the client to it, then running `pnpm admin key revoke --key <old keyId>`. The revocation takes effect within 30 seconds.
- When traffic grows, enable `redis_enabled` and `api_domain` (README, "Cost profile").

## Production

Production is a **separate project** with its own state, secrets, Anthropic key, data and budget. Dev must be working first: prod deploys the image digests that dev already ran, after a manual approval. It never rebuilds them.

**1. Create the project and state bucket.** Repeat steps 1–2 with `PROJECT_ID=synapset-prod`.

**2. Create a separate Anthropic key.** Give it its own spend limit in the Console, so a dev mistake can't consume production credits.

**3. Configure Terraform.**

```sh
cd infra/terraform
cp prod.tfvars.example prod.tfvars    # edit: github_repository, alert_email, billing account, budgets
```

`prod.tfvars` differs from dev in:

- `firestore_backups = true`: point-in-time recovery plus daily backups. API keys and accounts live in Firestore, so this is required.
- `promote_from_repository`: points at dev's Artifact Registry, so the prod deployer can read the images it promotes.
- higher `llm_daily_budget_usd` and `monthly_budget_usd`;
- `alert_email`, which is required in prod.

**4. Apply with a separate state prefix.** Run it as an operator with admin access to both projects, because the image-read grant lives in the dev project:

```sh
gcloud config set project synapset-prod
terraform init -reconfigure -backend-config="bucket=synapset-prod-tfstate" -backend-config="prefix=prod"
terraform apply -var-file=prod.tfvars -target=google_secret_manager_secret.anthropic_api_key
printf '%s' '<PROD_ANTHROPIC_API_KEY>' | gcloud secrets versions add synapset-prod-anthropic-api-key --data-file=-
terraform apply -var-file=prod.tfvars
```

To switch back to dev later, re-run `terraform init -reconfigure` with dev's bucket and prefix. Never apply `prod.tfvars` against dev state, or the reverse.

**5. Create the `prod` GitHub Environment.**

1. Go to **Settings → Environments → New environment → `prod`**.
2. Under **Required reviewers**, add yourself or the people allowed to release.
3. Set **Deployment branches** to `main` only.
4. Add the same four variables as dev, using values from the prod `terraform output`, plus:

| Variable                | Value                           |
| ----------------------- | ------------------------------- |
| `PROMOTE_FROM_REGISTRY` | dev's `ARTIFACT_REGISTRY` value |

Then add the **repository** variable `PROD_ENABLED = true`.

**6. Release.** Every merge to `main` deploys to dev automatically.

1. Check dev with the step 9 smoke test.
2. Open the workflow run and **Review deployments → Approve** for `prod`.
3. The job copies both images by digest and rolls them out.
4. Rerun the smoke test against prod with a prod key. Create prod accounts and keys with `GCP_PROJECT_ID=synapset-prod pnpm admin …`; dev keys don't work in prod.

**7. Restore, if ever needed.**

- **Point in time:** `gcloud firestore databases restore` from a backup (`gcloud firestore backups list`). Alternatively, read documents as of a past timestamp, within 7 days, through PITR.
- **Bad deploy:** Cloud Run → service → Revisions → send 100% of traffic to the previous revision.

**When prod traffic grows**, enable `redis_enabled` (use `STANDARD_HA` in prod) and `api_domain` with the WAF. After reviewing the WAF logs, set `waf_preview = false`. The costs are in the README's "Cost profile".

## Day-2 operations

| Task                                 | How                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| Switch to Gemini (credits exhausted) | Failover is automatic. To make it permanent: `llm_provider = "gemini"`, then apply. |
| Raise or lower the daily LLM budget  | `llm_daily_budget_usd`, then apply                                                  |
| Change a customer's plan             | `pnpm admin account plan --account <id> --plan enterprise`                          |
| Block a customer                     | `pnpm admin account suspend --account <id>`                                         |
| Replay dead-lettered jobs            | Pull from `assessment-generate-v1-dlq-inspect`, fix the cause, re-request the topic |
| Roll back a deploy                   | Cloud Run → service → Revisions → route 100% traffic to the previous revision       |
