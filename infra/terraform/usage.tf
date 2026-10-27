# Usage metering: API and worker publish events; a BigQuery subscription streams them into a partitioned
# table that billing and invoicing query. Delivery is at-least-once: deduplicate on event_id.
resource "google_bigquery_dataset" "usage" {
  dataset_id = replace("${local.name}_usage", "-", "_")
  location   = var.bigquery_location
  depends_on = [google_project_service.this]
}

resource "google_bigquery_table" "usage_events" {
  dataset_id          = google_bigquery_dataset.usage.dataset_id
  table_id            = "usage_events"
  deletion_protection = true

  time_partitioning {
    type  = "DAY"
    field = "occurred_at"
  }
  clustering = ["account_id", "event"]

  schema = jsonencode([
    { name = "event_id", type = "STRING", mode = "REQUIRED" },
    { name = "event", type = "STRING", mode = "REQUIRED", description = "api.request | llm.generation" },
    { name = "occurred_at", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "account_id", type = "STRING", mode = "REQUIRED" },
    { name = "key_id", type = "STRING", mode = "NULLABLE" },
    { name = "request_id", type = "STRING", mode = "NULLABLE" },
    { name = "method", type = "STRING", mode = "NULLABLE" },
    { name = "route", type = "STRING", mode = "NULLABLE" },
    { name = "status", type = "INT64", mode = "NULLABLE" },
    { name = "latency_ms", type = "INT64", mode = "NULLABLE" },
    { name = "match", type = "STRING", mode = "NULLABLE" },
    { name = "generation_queued", type = "BOOL", mode = "NULLABLE" },
    { name = "job_id", type = "STRING", mode = "NULLABLE" },
    { name = "provider", type = "STRING", mode = "NULLABLE" },
    { name = "model", type = "STRING", mode = "NULLABLE" },
    { name = "input_tokens", type = "INT64", mode = "NULLABLE" },
    { name = "output_tokens", type = "INT64", mode = "NULLABLE" },
    { name = "cost_usd", type = "FLOAT64", mode = "NULLABLE" },
  ])
}

resource "google_pubsub_topic" "usage" {
  name                       = "usage-events-v1"
  message_retention_duration = "604800s"
  depends_on                 = [google_project_service.this]
}

resource "google_pubsub_topic" "usage_dlq" {
  name       = "usage-events-v1-dlq"
  depends_on = [google_project_service.this]
}

resource "google_pubsub_subscription" "usage_dlq" {
  name                       = "usage-events-v1-dlq-inspect"
  topic                      = google_pubsub_topic.usage_dlq.id
  message_retention_duration = "604800s"
  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_subscription" "usage_bigquery" {
  name  = "usage-events-v1-bigquery"
  topic = google_pubsub_topic.usage.id

  bigquery_config {
    table               = "${var.project_id}.${google_bigquery_dataset.usage.dataset_id}.${google_bigquery_table.usage_events.table_id}"
    use_table_schema    = true
    drop_unknown_fields = true
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.usage_dlq.id
    max_delivery_attempts = 5
  }

  expiration_policy {
    ttl = ""
  }

  depends_on = [google_bigquery_table_iam_member.usage_writer]
}

resource "google_bigquery_table_iam_member" "usage_writer" {
  dataset_id = google_bigquery_dataset.usage.dataset_id
  table_id   = google_bigquery_table.usage_events.table_id
  role       = "roles/bigquery.dataEditor"
  member     = local.pubsub_agent
}

resource "google_pubsub_topic_iam_member" "usage_publisher" {
  for_each = local.runtime_members
  topic    = google_pubsub_topic.usage.id
  role     = "roles/pubsub.publisher"
  member   = each.value
}

resource "google_pubsub_topic_iam_member" "usage_dlq_publisher" {
  topic  = google_pubsub_topic.usage_dlq.id
  role   = "roles/pubsub.publisher"
  member = local.pubsub_agent
}

resource "google_pubsub_subscription_iam_member" "usage_dlq_subscriber" {
  subscription = google_pubsub_subscription.usage_bigquery.id
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}
