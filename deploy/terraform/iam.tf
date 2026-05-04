# ──────────────────────────────────────────────
# IAM Role + Instance Profile
# ──────────────────────────────────────────────

resource "aws_iam_role" "danxbot" {
  name = "${var.name}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_instance_profile" "danxbot" {
  name = "${var.name}-instance-profile"
  role = aws_iam_role.danxbot.name
}

# SSM Parameter Store read access — for pulling secrets at runtime
resource "aws_iam_role_policy" "ssm_read" {
  name = "${var.name}-ssm-read"
  role = aws_iam_role.danxbot.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath"
        ]
        Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${var.ssm_parameter_prefix}/*"
      }
    ]
  })
}

# ECR pull + push access. Push verbs are required because the Docker image
# is built ON the EC2 instance (not locally) and pushed to ECR from there
# — see deploy/build.ts#buildAndPushOnRemote. Building locally on WSL2
# was unreliable (Ubuntu archive CDN timeouts -> apt exit 100). Building
# on EC2 puts the build path on AWS's own network and keeps ECR push
# in-region.
resource "aws_iam_role_policy" "ecr_pull" {
  name = "${var.name}-ecr-pull"
  role = aws_iam_role.danxbot.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetAuthorizationToken",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage"
        ]
        Resource = "*"
      }
    ]
  })
}

# CloudWatch Logs — for shipping Docker container logs
resource "aws_iam_role_policy" "cloudwatch_logs" {
  name = "${var.name}-cloudwatch-logs"
  role = aws_iam_role.danxbot.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/danxbot/*"
      }
    ]
  })
}

# SSM managed instance — enables `aws ssm start-session` as an SSH alternative.
# The empty account ID in the ARN is correct: AWS-managed policies use a global
# ARN format without an account ID (arn:aws:iam::aws:policy/...).
resource "aws_iam_role_policy_attachment" "ssm_managed" {
  role       = aws_iam_role.danxbot.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
