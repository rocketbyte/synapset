# Global external Application Load Balancer + Cloud Armor in front of the API. Enabled when api_domain is set;
# the API's Cloud Run ingress is then restricted to the load balancer so the WAF cannot be bypassed.
locals {
  edge_enabled = var.api_domain != ""

  # OWASP ModSecurity CRS 3.3 rule sets. Sensitivity 1 has the fewest false positives; raise once tuned.
  waf_rules = {
    1000 = "sqli-v33-stable"
    1001 = "xss-v33-stable"
    1002 = "lfi-v33-stable"
    1003 = "rfi-v33-stable"
    1004 = "rce-v33-stable"
    1005 = "methodenforcement-v33-stable"
    1006 = "scannerdetection-v33-stable"
    1007 = "protocolattack-v33-stable"
    1008 = "sessionfixation-v33-stable"
    1009 = "nodejs-v33-stable"
  }
}

resource "google_compute_security_policy" "api" {
  count       = local.edge_enabled ? 1 : 0
  name        = "${local.name}-api"
  type        = "CLOUD_ARMOR"
  description = "WAF and edge rate limits for the public API"

  advanced_options_config {
    # Lets WAF rules inspect JSON bodies field by field instead of as raw text.
    json_parsing = "STANDARD"
    log_level    = "NORMAL"
  }

  adaptive_protection_config {
    layer_7_ddos_defense_config {
      enable = true
    }
  }

  dynamic "rule" {
    for_each = local.waf_rules
    content {
      priority    = rule.key
      action      = "deny(403)"
      preview     = var.waf_preview
      description = rule.value
      match {
        expr {
          expression = "evaluatePreconfiguredWaf('${rule.value}', {'sensitivity': 1})"
        }
      }
    }
  }

  # Coarse per-IP ceiling; abusive IPs are banned for 10 minutes. Plan limits are enforced in the API.
  rule {
    priority    = 2000
    action      = "rate_based_ban"
    description = "Per-IP flood protection"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action   = "allow"
      exceed_action    = "deny(429)"
      enforce_on_key   = "IP"
      ban_duration_sec = 600
      rate_limit_threshold {
        count        = var.edge_requests_per_ip_per_minute
        interval_sec = 60
      }
      ban_threshold {
        count        = var.edge_requests_per_ip_per_minute * 5
        interval_sec = 300
      }
    }
  }

  # Ceiling per credential across all IPs, above the largest plan; stops a leaked key being sprayed.
  rule {
    priority    = 2001
    action      = "throttle"
    description = "Per-API-key ceiling"
    match {
      expr {
        expression = "has(request.headers['authorization'])"
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key_configs {
        enforce_on_key_type = "HTTP_HEADER"
        enforce_on_key_name = "authorization"
      }
      rate_limit_threshold {
        count        = var.edge_requests_per_key_per_minute
        interval_sec = 60
      }
    }
  }

  rule {
    priority    = 2147483647
    action      = "allow"
    description = "Default allow"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_compute_region_network_endpoint_group" "api" {
  count                 = local.edge_enabled ? 1 : 0
  name                  = "${local.name}-api"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}

resource "google_compute_backend_service" "api" {
  count                 = local.edge_enabled ? 1 : 0
  name                  = "${local.name}-api"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.api[0].id

  backend {
    group = google_compute_region_network_endpoint_group.api[0].id
  }

  log_config {
    enable      = true
    sample_rate = 1
  }
}

resource "google_compute_url_map" "api" {
  count           = local.edge_enabled ? 1 : 0
  name            = "${local.name}-api"
  default_service = google_compute_backend_service.api[0].id
}

resource "google_compute_managed_ssl_certificate" "api" {
  count = local.edge_enabled ? 1 : 0
  name  = "${local.name}-api"
  managed {
    domains = [var.api_domain]
  }
}

resource "google_compute_ssl_policy" "api" {
  count           = local.edge_enabled ? 1 : 0
  name            = "${local.name}-api"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_target_https_proxy" "api" {
  count            = local.edge_enabled ? 1 : 0
  name             = "${local.name}-api"
  url_map          = google_compute_url_map.api[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.api[0].id]
  ssl_policy       = google_compute_ssl_policy.api[0].id
}

resource "google_compute_global_address" "api" {
  count = local.edge_enabled ? 1 : 0
  name  = "${local.name}-api"
}

resource "google_compute_global_forwarding_rule" "api_https" {
  count                 = local.edge_enabled ? 1 : 0
  name                  = "${local.name}-api-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.api[0].id
  port_range            = "443"
  target                = google_compute_target_https_proxy.api[0].id
}

resource "google_compute_url_map" "api_redirect" {
  count = local.edge_enabled ? 1 : 0
  name  = "${local.name}-api-redirect"
  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "api_redirect" {
  count   = local.edge_enabled ? 1 : 0
  name    = "${local.name}-api-redirect"
  url_map = google_compute_url_map.api_redirect[0].id
}

resource "google_compute_global_forwarding_rule" "api_http" {
  count                 = local.edge_enabled ? 1 : 0
  name                  = "${local.name}-api-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.api[0].id
  port_range            = "80"
  target                = google_compute_target_http_proxy.api_redirect[0].id
}
