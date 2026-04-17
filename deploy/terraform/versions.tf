terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # S3 backend — bucket and DynamoDB table are bootstrapped by the deploy CLI
  # before the first `terraform init`. Values are injected via -backend-config flags.
  backend "s3" {}
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project   = "danxbot"
      ManagedBy = "terraform"
      Name      = var.name
    }
  }
}
