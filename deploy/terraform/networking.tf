# ──────────────────────────────────────────────
# Security Group
# ──────────────────────────────────────────────

resource "aws_security_group" "danxbot" {
  name        = "${var.name}-sg"
  description = "Danxbot instance - HTTPS + SSH inbound, all outbound"
  vpc_id      = data.aws_vpc.default.id

  # HTTPS (Caddy reverse proxy)
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP (Let's Encrypt ACME challenge + redirect to HTTPS)
  ingress {
    description = "HTTP for ACME challenge"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # SSH (restricted to configured CIDRs)
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_cidrs
  }

  # All outbound (Slack, Trello, Anthropic, GitHub, external service integrations)
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ──────────────────────────────────────────────
# Elastic IP
# ──────────────────────────────────────────────

resource "aws_eip" "danxbot" {
  domain = "vpc"

  tags = {
    Name = "${var.name}-eip"
  }
}

resource "aws_eip_association" "danxbot" {
  instance_id   = aws_instance.danxbot.id
  allocation_id = aws_eip.danxbot.id
}

# ──────────────────────────────────────────────
# Route53 DNS Record
# ──────────────────────────────────────────────

resource "aws_route53_record" "danxbot" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.danxbot.public_ip]
}
