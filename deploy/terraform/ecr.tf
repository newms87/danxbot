# ──────────────────────────────────────────────
# ECR Repository
# ──────────────────────────────────────────────

resource "aws_ecr_repository" "danxbot" {
  name                 = var.name
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }
}

# Keep only the last 10 untagged images to avoid storage cost creep
resource "aws_ecr_lifecycle_policy" "danxbot" {
  repository = aws_ecr_repository.danxbot.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 untagged images"
        selection = {
          tagStatus   = "untagged"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
