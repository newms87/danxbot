# ──────────────────────────────────────────────
# SSH Key Pair (generated when ssh_key_name is empty)
# ──────────────────────────────────────────────

resource "tls_private_key" "danxbot" {
  count     = var.ssh_key_name == "" ? 1 : 0
  algorithm = "ED25519"
}

resource "aws_key_pair" "generated" {
  count      = var.ssh_key_name == "" ? 1 : 0
  key_name   = "${var.name}-key"
  public_key = tls_private_key.danxbot[0].public_key_openssh
}

# ──────────────────────────────────────────────
# EC2 Instance
# ──────────────────────────────────────────────

resource "aws_instance" "danxbot" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = var.ssh_key_name != "" ? var.ssh_key_name : aws_key_pair.generated[0].key_name
  vpc_security_group_ids = [aws_security_group.danxbot.id]
  iam_instance_profile   = aws_iam_instance_profile.danxbot.name
  subnet_id              = data.aws_subnets.default.ids[0]

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.volume_size
    encrypted             = true
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/../templates/cloud-init.yaml.tpl", {
    name             = var.name
    domain           = var.domain
    dashboard_port   = var.dashboard_port
    region           = var.region
    data_device      = "/dev/xvdf"
    ssm_prefix       = var.ssm_parameter_prefix
    ecr_registry     = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"
    ecr_repo         = aws_ecr_repository.danxbot.name
  })

  tags = {
    Name = var.name
  }

  # Ignore user_data changes — cloud-init only runs on first boot.
  # Subsequent deploys are handled by the deploy CLI via SSH.
  lifecycle {
    ignore_changes = [user_data, ami]
  }
}

# ──────────────────────────────────────────────
# Data Volume (persistent across instance replacement)
# ──────────────────────────────────────────────

resource "aws_ebs_volume" "data" {
  availability_zone = aws_instance.danxbot.availability_zone
  size              = var.data_volume_size
  type              = "gp3"
  encrypted         = true

  tags = {
    Name = "${var.name}-data"
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/xvdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.danxbot.id

  # Don't destroy the volume when detaching — data must survive
  force_detach = false
}
