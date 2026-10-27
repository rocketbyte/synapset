# Optional Redis (redis_enabled). Off by default: limits then live in Firestore with no fixed cost.
# See README "Cost profile". The VPC and subnet are free; the Redis instance is the fixed cost.
# Cloud Run reaches it with Direct VPC egress (no connector to pay for).
resource "google_compute_network" "this" {
  count                   = var.redis_enabled ? 1 : 0
  name                    = local.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.this]
}

resource "google_compute_subnetwork" "run" {
  count                    = var.redis_enabled ? 1 : 0
  name                     = "${local.name}-run"
  network                  = google_compute_network.this[0].id
  region                   = var.region
  ip_cidr_range            = "10.10.0.0/24"
  private_ip_google_access = true
}

# Shared counters for rate limits, quotas and LLM spend. AUTH + in-transit TLS; reachable only from the VPC.
resource "google_redis_instance" "limits" {
  count                   = var.redis_enabled ? 1 : 0
  name                    = "${local.name}-limits"
  region                  = var.region
  tier                    = var.redis_tier
  memory_size_gb          = 1
  redis_version           = "REDIS_7_2"
  authorized_network      = google_compute_network.this[0].id
  connect_mode            = "DIRECT_PEERING"
  auth_enabled            = true
  transit_encryption_mode = "SERVER_AUTHENTICATION"

  maintenance_policy {
    weekly_maintenance_window {
      day = "SUNDAY"
      start_time {
        hours = 4
      }
    }
  }

  depends_on = [google_project_service.this]
}

# The AUTH string is also in Terraform state: keep the state bucket restricted to operators.
resource "google_secret_manager_secret" "redis_url" {
  count     = var.redis_enabled ? 1 : 0
  secret_id = "${local.name}-redis-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret_version" "redis_url" {
  count       = var.redis_enabled ? 1 : 0
  secret      = google_secret_manager_secret.redis_url[0].id
  secret_data = "rediss://:${google_redis_instance.limits[0].auth_string}@${google_redis_instance.limits[0].host}:${google_redis_instance.limits[0].port}"
}

resource "google_secret_manager_secret_iam_member" "redis_url" {
  for_each  = var.redis_enabled ? local.runtime_members : {}
  secret_id = google_secret_manager_secret.redis_url[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}
