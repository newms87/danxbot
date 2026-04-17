# ──────────────────────────────────────────────
# Core
# ──────────────────────────────────────────────

variable "name" {
  description = "Deployment name — used as prefix for all AWS resources"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.name))
    error_message = "name must be lowercase alphanumeric with hyphens only"
  }
}

variable "region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "AWS CLI profile name (required — multi-deployment safety)"
  type        = string
}

# ──────────────────────────────────────────────
# Compute
# ──────────────────────────────────────────────

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.small"
}

variable "volume_size" {
  description = "Root EBS volume size in GB"
  type        = number
  default     = 30
}

variable "data_volume_size" {
  description = "Data EBS volume size in GB (repos, threads, mysql, claude-auth)"
  type        = number
  default     = 100
}

variable "ssh_key_name" {
  description = "Name of an existing AWS EC2 key pair for SSH access. Leave empty to generate one."
  type        = string
  default     = ""
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to SSH into the instance"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ──────────────────────────────────────────────
# DNS
# ──────────────────────────────────────────────

variable "domain" {
  description = "Full domain name for the dashboard (e.g. danxbot.example.com)"
  type        = string
}

variable "hosted_zone" {
  description = "Route53 hosted zone name (e.g. example.com)"
  type        = string
}

# ──────────────────────────────────────────────
# Secrets (SSM parameter paths)
# ──────────────────────────────────────────────

variable "ssm_parameter_prefix" {
  description = "SSM Parameter Store prefix for secrets (e.g. /danxbot-gpt)"
  type        = string
}

# ──────────────────────────────────────────────
# Dashboard
# ──────────────────────────────────────────────

variable "dashboard_port" {
  description = "Port the danxbot dashboard listens on inside the container"
  type        = number
  default     = 5555
}
