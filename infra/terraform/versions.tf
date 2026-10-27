terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.8"
    }
  }

  # Configure per environment: terraform init -backend-config="bucket=<state-bucket>" -backend-config="prefix=<env>"
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_project" "this" {}
