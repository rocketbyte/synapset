resource "google_firestore_database" "main" {
  name                    = "(default)"
  location_id             = var.firestore_location
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  # Recover from bad writes (e.g. a mistaken admin command) to any minute in the last 7 days. Billed per use.
  point_in_time_recovery_enablement = var.firestore_backups ? "POINT_IN_TIME_RECOVERY_ENABLED" : "POINT_IN_TIME_RECOVERY_DISABLED"
  deletion_policy                   = "ABANDON"

  depends_on = [google_project_service.this]
}

# Pre-filtered KNN: where('scope', '==', s).findNearest('embedding', ...). Dimension must equal EMBEDDING_DIMENSIONS.
resource "google_firestore_index" "assessments_vector" {
  database   = google_firestore_database.main.name
  collection = "assessments"

  fields {
    field_path = "scope"
    order      = "ASCENDING"
  }

  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }

  fields {
    field_path = "embedding"
    vector_config {
      dimension = 768
      flat {}
    }
  }
}

# TTL deletes expired documents (typically within 24h); the services check expiresAt themselves.
# Timestamp fields are exempt from indexing to avoid write hotspots.
resource "google_firestore_field" "expires_at" {
  for_each   = toset(["assessments", "topic_keys", "jobs", "limits"])
  database   = google_firestore_database.main.name
  collection = each.value
  field      = "expiresAt"

  ttl_config {}
  index_config {}
}

# The question array is never queried; indexing it would multiply write cost.
resource "google_firestore_field" "questions_unindexed" {
  database   = google_firestore_database.main.name
  collection = "assessments"
  field      = "questions"

  index_config {}
}

# Daily backups for disaster recovery beyond the PITR window. Billed per GB stored; no fixed cost.
resource "google_firestore_backup_schedule" "daily" {
  count     = var.firestore_backups ? 1 : 0
  database  = google_firestore_database.main.name
  retention = "${var.firestore_backup_retention_days * 86400}s"
  daily_recurrence {}
}
