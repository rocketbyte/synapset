locals {
  # Shared by the subscription's dead-letter policy and the worker's final-attempt handling.
  max_delivery_attempts = 5

  common_env = {
    NODE_ENV             = "production"
    GCP_PROJECT_ID       = var.project_id
    VERTEX_LOCATION      = "global"
    PUBSUB_TOPIC         = google_pubsub_topic.generate.name
    USAGE_TOPIC          = google_pubsub_topic.usage.name
    QUESTIONS_PER_LEVEL  = tostring(var.questions_per_level)
    LLM_DAILY_BUDGET_USD = tostring(var.llm_daily_budget_usd)

    QUESTION_POOL_TTL_SECONDS     = tostring(var.question_pool_ttl_seconds)
    QUESTION_POOL_CAP             = tostring(var.question_pool_cap)
    QUESTION_POOL_BATCH_PER_LEVEL = tostring(var.question_pool_batch_per_level)
  }

  # Public CA certificate of the Memorystore instance; not a secret.
  redis_env = var.redis_enabled ? { REDIS_CA_CERT = google_redis_instance.limits[0].server_ca_certs[0].cert } : {}

  # Behind the load balancer, X-Forwarded-For is "<client>, <lb>"; without it Cloud Run appends only the client.
  trusted_proxy_hops = local.edge_enabled ? 2 : 1
}

resource "google_cloud_run_v2_service" "api" {
  name                = "${local.name}-api"
  location            = var.region
  ingress             = local.edge_enabled ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account                  = google_service_account.api.email
    max_instance_request_concurrency = 80
    timeout                          = "30s"

    dynamic "vpc_access" {
      for_each = var.redis_enabled ? [1] : []
      content {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.this[0].id
          subnetwork = google_compute_subnetwork.run[0].id
        }
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = var.api_max_instances
    }

    containers {
      image = var.api_image

      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = merge(local.common_env, local.redis_env, {
          ASSESSMENT_TTL_SECONDS = tostring(var.assessment_ttl_seconds)
          TRUSTED_PROXY_HOPS     = tostring(local.trusted_proxy_hops)
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.redis_enabled ? [google_secret_manager_secret.redis_url[0].secret_id] : []
        content {
          name = "REDIS_URL"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      # The server listens only after it has fully initialised, so a TCP probe is enough, and it doesn't tie
      # Terraform to a route in the image that CI deploys.
      startup_probe {
        tcp_socket {
          port = 8080
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_secret_manager_secret_iam_member.redis_url, google_secret_manager_secret_version.redis_url]
}

# Requests are authenticated in-app with API keys. With api_domain set, ingress only accepts the load balancer.
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service" "worker" {
  name                = "${local.name}-worker"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = true

  template {
    service_account                  = google_service_account.worker.email
    max_instance_request_concurrency = 4
    timeout                          = "600s"

    dynamic "vpc_access" {
      for_each = var.redis_enabled ? [1] : []
      content {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.this[0].id
          subnetwork = google_compute_subnetwork.run[0].id
        }
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = var.worker_max_instances
    }

    containers {
      image = var.worker_image

      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = merge(local.common_env, local.redis_env, {
          LLM_PROVIDER          = var.llm_provider
          LLM_FALLBACK_PROVIDER = var.llm_fallback_provider
          ANTHROPIC_MODEL       = var.anthropic_model
          GEMINI_MODEL          = var.gemini_model
          MAX_DELIVERY_ATTEMPTS = tostring(local.max_delivery_attempts)
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.redis_enabled ? [google_secret_manager_secret.redis_url[0].secret_id] : []
        content {
          name = "REDIS_URL"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      env {
        name = "ANTHROPIC_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.anthropic_api_key.secret_id
            version = "latest"
          }
        }
      }

      # The server listens only after it has fully initialised, so a TCP probe is enough, and it doesn't tie
      # Terraform to a route in the image that CI deploys.
      startup_probe {
        tcp_socket {
          port = 8080
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.anthropic_api_key,
    google_secret_manager_secret_iam_member.redis_url,
    google_secret_manager_secret_version.redis_url,
  ]
}
