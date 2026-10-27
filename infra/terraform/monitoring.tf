# Alerts are created when alert_email is set; the billing budget when billing_account_id is set.
locals {
  alerts_enabled = var.alert_email != ""
  channels       = local.alerts_enabled ? [google_monitoring_notification_channel.email[0].id] : []

  log_alerts = {
    budget_exhausted = {
      display = "Daily LLM budget exhausted"
      filter  = "jsonPayload.message=\"Daily LLM budget exhausted; new generations are paused\""
    }
    llm_failover = {
      display = "LLM provider failover"
      filter  = "jsonPayload.message=~\"failing over\""
    }
    usage_lost = {
      display = "Usage events failed to publish (billing data at risk)"
      filter  = "jsonPayload.message=\"Failed to publish usage event\""
    }
  }

  dlq_subscriptions = {
    generate = google_pubsub_subscription.generate_dlq.name
    usage    = google_pubsub_subscription.usage_dlq.name
  }
}

resource "google_monitoring_notification_channel" "email" {
  count        = local.alerts_enabled ? 1 : 0
  display_name = "${local.name} on-call"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

resource "google_logging_metric" "alerts" {
  for_each = local.log_alerts
  name     = "${local.name}/${each.key}"
  filter   = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=~\"^${local.name}-\" AND ${each.value.filter}"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "logs" {
  for_each              = local.alerts_enabled ? local.log_alerts : {}
  display_name          = "${local.name}: ${each.value.display}"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = each.value.display
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.alerts[each.key].name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  alert_strategy {
    auto_close = "86400s"
  }
}

resource "google_monitoring_alert_policy" "dlq" {
  for_each              = local.alerts_enabled ? local.dlq_subscriptions : {}
  display_name          = "${local.name}: messages in ${each.value}"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "Undelivered dead-letter messages"
    condition_threshold {
      filter          = "resource.type=\"pubsub_subscription\" AND resource.labels.subscription_id=\"${each.value}\" AND metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "api_5xx" {
  count                 = local.alerts_enabled ? 1 : 0
  display_name          = "${local.name}: API 5xx responses"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "5xx rate above 1/s for 5 minutes"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${google_cloud_run_v2_service.api.name}\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.labels.response_code_class=\"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
}

# Project-wide cost guard (Cloud spend, including Vertex AI). Anthropic spend is billed separately and is
# capped by LLM_DAILY_BUDGET_USD plus the spend limit in the Anthropic Console.
resource "google_billing_budget" "project" {
  count           = var.billing_account_id != "" ? 1 : 0
  billing_account = var.billing_account_id
  display_name    = "${local.name} monthly"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_budget_usd)
    }
  }

  dynamic "threshold_rules" {
    for_each = [0.5, 0.9, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }

  all_updates_rule {
    monitoring_notification_channels = local.channels
    disable_default_iam_recipients   = false
  }
}
