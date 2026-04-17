# ──────────────────────────────────────────────
# Data Sources
# ──────────────────────────────────────────────

# Latest Ubuntu 22.04 LTS AMI from Canonical
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

# Route53 hosted zone lookup
data "aws_route53_zone" "main" {
  name         = var.hosted_zone
  private_zone = false
}

# Default VPC — no custom VPC needed for a single-instance deployment
data "aws_vpc" "default" {
  default = true
}

# Default subnets in the default VPC
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# Current caller identity (for ECR auth and resource naming)
data "aws_caller_identity" "current" {}
