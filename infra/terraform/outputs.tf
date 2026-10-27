output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account" {
  value = google_service_account.deployer.email
}

output "api_ip" {
  description = "Point the api_domain DNS A record here; the managed certificate provisions once it resolves."
  value       = local.edge_enabled ? google_compute_global_address.api[0].address : null
}

output "usage_table" {
  value = "${var.project_id}.${google_bigquery_dataset.usage.dataset_id}.${google_bigquery_table.usage_events.table_id}"
}

output "fixed_monthly_cost" {
  description = "Approximate always-on cost of the enabled optional components (USD/month)."
  value = {
    redis         = var.redis_enabled ? (var.redis_tier == "BASIC" ? 36 : 72) : 0
    load_balancer = local.edge_enabled ? 18 + 5 + length(local.waf_rules) + 2 : 0
  }
}
