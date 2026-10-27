resource "google_pubsub_topic" "generate" {
  name                       = "assessment-generate-v1"
  message_retention_duration = "86400s"
  depends_on                 = [google_project_service.this]
}

resource "google_pubsub_topic" "generate_dlq" {
  name       = "assessment-generate-v1-dlq"
  depends_on = [google_project_service.this]
}

resource "google_pubsub_subscription" "generate_worker" {
  name  = "assessment-generate-v1-worker"
  topic = google_pubsub_topic.generate.id

  # Matches the worker's Cloud Run request timeout.
  ack_deadline_seconds = 600

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.worker.uri}/pubsub/generate"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = google_cloud_run_v2_service.worker.uri
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.generate_dlq.id
    max_delivery_attempts = local.max_delivery_attempts
  }

  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_subscription" "generate_dlq" {
  name                       = "assessment-generate-v1-dlq-inspect"
  topic                      = google_pubsub_topic.generate_dlq.id
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = ""
  }
}

# The Pub/Sub service agent forwards undeliverable messages to the dead-letter topic.
resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  topic  = google_pubsub_topic.generate_dlq.id
  role   = "roles/pubsub.publisher"
  member = local.pubsub_agent
}

resource "google_pubsub_subscription_iam_member" "dlq_subscriber" {
  subscription = google_pubsub_subscription.generate_worker.id
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}
