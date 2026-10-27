# Keyless deploys from GitHub Actions via Workload Identity Federation.
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${local.name}-github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  attribute_mapping = {
    "google.subject"        = "assertion.sub"
    "attribute.repository"  = "assertion.repository"
    "attribute.ref"         = "assertion.ref"
    "attribute.environment" = "assertion.environment"
  }
  # Only jobs on main that run in the GitHub Environment named like this environment (dev, prod) may deploy.
  # Protect the prod GitHub Environment with required reviewers.
  attribute_condition = join(" && ", [
    "assertion.repository == '${var.github_repository}'",
    "assertion.ref == 'refs/heads/main'",
    "assertion.environment == '${var.environment}'",
  ])
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deployer" {
  account_id   = "${local.name}-deployer"
  display_name = "Synapset CI deployer"
}

resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  repository = google_artifact_registry_repository.images.name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.deployer.member
}

resource "google_cloud_run_v2_service_iam_member" "deployer" {
  for_each = { api = google_cloud_run_v2_service.api.name, worker = google_cloud_run_v2_service.worker.name }
  name     = each.value
  location = var.region
  role     = "roles/run.developer"
  member   = google_service_account.deployer.member
}

# Deploying a revision that runs as a service account requires actAs on it.
resource "google_service_account_iam_member" "deployer_act_as" {
  for_each           = { api = google_service_account.api.name, worker = google_service_account.worker.name }
  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deployer.member
}

# Production deploys promote the image already verified in a lower environment instead of rebuilding it.
resource "google_artifact_registry_repository_iam_member" "deployer_promote_from" {
  count      = var.promote_from_repository == null ? 0 : 1
  project    = var.promote_from_repository.project
  location   = var.promote_from_repository.location
  repository = var.promote_from_repository.repository
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.deployer.member
}
