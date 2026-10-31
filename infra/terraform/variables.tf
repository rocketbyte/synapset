variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "environment" {
  description = "Short environment name used in resource names, e.g. dev or prod."
  type        = string
}

variable "firestore_location" {
  description = "Firestore location: a multi-region such as nam5 or a region such as us-central1."
  type        = string
  default     = "nam5"
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through Workload Identity Federation."
  type        = string
}

variable "api_image" {
  description = "Initial API image. CI deploys new revisions; Terraform ignores later image changes."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "worker_image" {
  description = "Initial worker image. CI deploys new revisions; Terraform ignores later image changes."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "llm_provider" {
  type    = string
  default = "anthropic"
}

variable "llm_fallback_provider" {
  type    = string
  default = "gemini"
}

variable "anthropic_model" {
  type    = string
  default = "claude-haiku-5-5"
}

variable "gemini_model" {
  type    = string
  default = "gemini-3.5-flash-lite"
}

variable "assessment_ttl_seconds" {
  type    = number
  default = 2592000
}

variable "questions_per_level" {
  type    = number
  default = 10
}

variable "question_pool_ttl_seconds" {
  description = "Lifetime of pool questions. Two years: long enough that a question is rarely paid for twice."
  type        = number
  default     = 63072000
}

variable "question_pool_cap" {
  description = "Default questions per topic, language, audience, tone and difficulty. pnpm admin pool-cap overrides it live."
  type        = number
  default     = 300
}

variable "question_pool_batch_per_level" {
  description = "New questions per level each time a pool runs out. Small, so pools grow only as they are used."
  type        = number
  default     = 6
}

variable "api_max_instances" {
  type    = number
  default = 10
}

variable "worker_max_instances" {
  description = "Caps concurrent LLM calls (instances x concurrency) to stay inside provider rate limits."
  type        = number
  default     = 5
}

variable "llm_daily_budget_usd" {
  description = "Hard ceiling on LLM spend per UTC day; new generations pause once reached."
  type        = number
  default     = 20
}

variable "redis_enabled" {
  description = "Memorystore Redis for exact, shared rate limits at high traffic (~$36/month). Off: Firestore, no fixed cost."
  type        = bool
  default     = false
}

variable "redis_tier" {
  description = "BASIC (single node, ~$36/month) or STANDARD_HA (replicated, for production SLAs)."
  type        = string
  default     = "BASIC"
}

variable "api_domain" {
  description = "Public API hostname. When set, the API is served only through a load balancer with Cloud Armor (~$34+/month). Empty: Cloud Run URL, no fixed cost."
  type        = string
  default     = ""
}

variable "waf_preview" {
  description = "Run WAF rules in preview (log only). Review the logs for false positives before enforcing."
  type        = bool
  default     = true
}

variable "edge_requests_per_ip_per_minute" {
  type    = number
  default = 600
}

variable "edge_requests_per_key_per_minute" {
  description = "Edge ceiling per API key; keep above the largest plan's requestsPerMinute."
  type        = number
  default     = 3000
}

variable "bigquery_location" {
  type    = string
  default = "US"
}

variable "alert_email" {
  type    = string
  default = ""
}

variable "billing_account_id" {
  description = "Billing account for the project budget alert; empty disables it."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  type    = number
  default = 200
}

variable "firestore_backups" {
  description = "Point-in-time recovery (7 days) and daily backups. Pay per use; enable for production."
  type        = bool
  default     = false
}

variable "firestore_backup_retention_days" {
  type    = number
  default = 14
}

variable "promote_from_repository" {
  description = "Artifact Registry repository this environment promotes images from (prod: the dev repository)."
  type = object({
    project    = string
    location   = string
    repository = string
  })
  default = null
}
