# ──────────────────────────────────────────────
# Outputs
# ──────────────────────────────────────────────

output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.danxbot.id
}

output "public_ip" {
  description = "Elastic IP address"
  value       = aws_eip.danxbot.public_ip
}

output "domain" {
  description = "Dashboard URL"
  value       = "https://${var.domain}"
}

output "ecr_repository_url" {
  description = "ECR repository URL for pushing Docker images"
  value       = aws_ecr_repository.danxbot.repository_url
}

output "ssh_command" {
  description = "SSH command to connect to the instance"
  value       = "ssh -i ${var.ssh_key_name != "" ? "<your-key>.pem" : "~/.ssh/${var.name}-key.pem"} ubuntu@${aws_eip.danxbot.public_ip}"
}

output "ssh_private_key" {
  description = "Generated SSH private key (only when ssh_key_name is empty)"
  value       = var.ssh_key_name == "" ? tls_private_key.danxbot[0].private_key_openssh : ""
  sensitive   = true
}

output "security_group_id" {
  description = "Security group ID"
  value       = aws_security_group.danxbot.id
}

output "data_volume_id" {
  description = "Persistent data EBS volume ID"
  value       = aws_ebs_volume.data.id
}

output "iam_role_arn" {
  description = "IAM role ARN for the EC2 instance"
  value       = aws_iam_role.danxbot.arn
}
