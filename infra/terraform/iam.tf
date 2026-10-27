resource "google_service_account" "api" {
  account_id   = "${local.name}-api"
  display_name = "Synapset API"
}

resource "google_service_account" "worker" {
  account_id   = "${local.name}-worker"
  display_name = "Synapset worker"
}

resource "google_service_account" "pubsub_push" {
  account_id   = "${local.name}-push"
  display_name = "Synapset Pub/Sub push identity"
}

locals {
  runtime_roles = {
    api    = ["roles/datastore.user", "roles/aiplatform.user"]
    worker = ["roles/datastore.user", "roles/aiplatform.user"]
  }
  runtime_members = {
    api    = google_service_account.api.member
    worker = google_service_account.worker.member
  }
  runtime_bindings = merge([
    for sa, roles in local.runtime_roles : { for role in roles : "${sa}:${role}" => { member = local.runtime_members[sa], role = role } }
  ]...)
}

resource "google_project_iam_member" "runtime" {
  for_each = local.runtime_bindings
  project  = var.project_id
  role     = each.value.role
  member   = each.value.member
}

resource "google_pubsub_topic_iam_member" "api_publisher" {
  topic  = google_pubsub_topic.generate.id
  role   = "roles/pubsub.publisher"
  member = google_service_account.api.member
}

resource "google_secret_manager_secret_iam_member" "anthropic_api_key" {
  secret_id = google_secret_manager_secret.anthropic_api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.worker.member
}

# Only Pub/Sub's push identity may invoke the worker.
resource "google_cloud_run_v2_service_iam_member" "worker_invoker" {
  name     = google_cloud_run_v2_service.worker.name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_service_account.pubsub_push.member
}

resource "google_service_account_iam_member" "pubsub_token_creator" {
  service_account_id = google_service_account.pubsub_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_agent
}
