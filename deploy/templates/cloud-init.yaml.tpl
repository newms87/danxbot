#cloud-config
package_update: true
package_upgrade: true

packages:
  - apt-transport-https
  - ca-certificates
  - curl
  - gnupg
  - lsb-release
  - unattended-upgrades
  - jq
  - unzip

bootcmd:
  - |
    if ! blkid ${data_device}; then
      mkfs.ext4 ${data_device}
    fi

mounts:
  - ["${data_device}", "/danxbot", "ext4", "defaults,nofail", "0", "2"]

runcmd:
  # ── Docker CE ──
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  - usermod -aG docker ubuntu

  # ── Caddy (auto-TLS reverse proxy) ──
  - curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  - curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  - apt-get update
  - apt-get install -y caddy

  # ── Caddyfile ──
  - |
    cat > /etc/caddy/Caddyfile <<'CADDY'
    ${domain} {
        reverse_proxy localhost:${dashboard_port}
    }
    CADDY
  - systemctl restart caddy
  - systemctl enable caddy

  # ── Create data directories ──
  - mkdir -p /danxbot/repos /danxbot/threads /danxbot/data /danxbot/logs /danxbot/claude-auth /danxbot/mysql-data /danxbot/claude-projects
  # Containers run as uid 1001 (useradd -m danxbot in the Dockerfile — first
  # non-system user). The shared claude-projects mount must be writable by
  # that uid from every container (workers write, dashboard reads).
  - chown -R ubuntu:ubuntu /danxbot
  # Container uid is 1000 (useradd -m danxbot — first non-system uid).
  # On Ubuntu hosts 1000 = ubuntu, so this no-op matches what the chown
  # above already set; the explicit numeric chown documents the contract.
  - chown -R 1000:1000 /danxbot/claude-projects

  # ── AWS CLI v2 ──
  - curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip
  - unzip -q /tmp/awscli.zip -d /tmp/awscli
  - /tmp/awscli/aws/install
  - rm -rf /tmp/awscli /tmp/awscli.zip

  # ── ECR login helper ──
  - |
    cat > /usr/local/bin/ecr-login.sh <<'SCRIPT'
    #!/bin/bash
    set -euo pipefail
    /usr/local/bin/aws ecr get-login-password --region ${region} | /usr/bin/docker login --username AWS --password-stdin ${ecr_registry}
    SCRIPT
    chmod +x /usr/local/bin/ecr-login.sh

  # ── danxbot systemd unit (starts shared-infra compose on boot) ──
  - |
    cat > /etc/systemd/system/danxbot.service <<'UNIT'
    [Unit]
    Description=Danxbot shared infra compose
    After=docker.service
    Requires=docker.service

    [Service]
    Type=oneshot
    RemainAfterExit=yes
    WorkingDirectory=/danxbot
    ExecStartPre=/usr/local/bin/ecr-login.sh
    ExecStart=/usr/bin/docker compose -f /danxbot/docker-compose.prod.yml up -d --remove-orphans
    ExecStop=/usr/bin/docker compose -f /danxbot/docker-compose.prod.yml down
    Restart=on-failure
    RestartSec=10

    [Install]
    WantedBy=multi-user.target
    UNIT
  - systemctl daemon-reload
  - systemctl enable danxbot.service

final_message: "Danxbot instance bootstrap complete. Cloud-init finished at $UPTIME seconds."
