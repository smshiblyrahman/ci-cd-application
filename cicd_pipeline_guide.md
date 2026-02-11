# Self-Hosted CI/CD Pipeline
## GitHub Actions + Docker + Nginx + SSL — Revlek DevOps Implementation Guide

> **Tech Stack:** GitHub Actions • Docker & Docker Hub / AWS ECR • DigitalOcean Droplet / AWS EC2 (Ubuntu 22.04) • Nginx Reverse Proxy • Certbot / Let's Encrypt • Cursor AI IDE
> 
> **Estimated Setup Time:** 3–5 hours for a fresh environment

---

## Pipeline Overview

```
[Git Push] → [GitHub Actions] → [Docker Build] → [Push to Registry] → [SSH Deploy] → [Nginx + SSL]
```

| Stage | Tool | What Happens |
|---|---|---|
| Trigger | GitHub Actions | Push to `main` starts the pipeline |
| Test | Actions Runner | Runs your test suite and linter |
| Build | Docker Buildx | Multi-stage image built and tagged |
| Push | Docker Hub / ECR | Image pushed with `latest` + SHA tags |
| Deploy | appleboy/ssh-action | SSH into server, pull image, recreate container |
| Serve | Nginx + Let's Encrypt | Reverse proxy with HTTPS and security headers |

---

## Table of Contents

1. [Project Structure & Cursor AI Setup](#section-1)
2. [Dockerfile & Application Container](#section-2)
3. [GitHub Actions CI/CD Pipeline](#section-3)
4. [Server Provisioning (DigitalOcean / EC2)](#section-4)
5. [Nginx Reverse Proxy Configuration](#section-5)
6. [SSH Key Setup & Security](#section-6)
7. [Environment Variables & Secrets Management](#section-7)
8. [Zero-Downtime Deployment Strategy](#section-8)
9. [Monitoring & Observability](#section-9)
10. [Rollback Strategy](#section-10)
11. [Cursor AI Workflow Integration](#section-11)
12. [Troubleshooting Reference](#section-12)
13. [Full Pre-Launch Checklist](#section-13)

---

<a name="section-1"></a>
## Section 1 — Project Structure & Cursor AI Setup

### 1.1 Opening the Project in Cursor AI

Cursor AI is a VS Code fork with built-in AI capabilities. It natively understands Docker, CI/CD pipelines, and GitHub Actions. Open your project workspace in Cursor and use the integrated terminal for every shell command in this guide.

**Essential Cursor shortcuts for this project:**
- `Ctrl+K` — Inline AI edit (generate Dockerfile contents from a comment)
- `Ctrl+L` — Chat with AI about your codebase
- `Ctrl+Shift+P` — Command palette (create files, run commands)
- `@Codebase` — In chat, lets AI understand your entire repo before answering

### 1.2 Recommended Repository Structure

Create this layout at the root of your repository:

```
my-app/
├── .github/
│   └── workflows/
│       └── deploy.yml          # Main CI/CD pipeline
├── docker/
│   └── nginx/
│       └── default.conf        # Nginx reverse proxy config
├── src/                        # Your application source code
│   ├── index.js  (or app.py)   # Entry point
│   └── ...
├── Dockerfile                  # Container build instructions
├── docker-compose.yml          # Local dev compose
├── docker-compose.prod.yml     # Production compose
├── .env.example                # Template for env vars (commit this)
├── .dockerignore               # Exclude files from Docker context
└── README.md
```

### 1.3 Cursor AI Tips for This Project

- Use `Ctrl+K` to generate Dockerfile contents from a comment like `// Dockerfile for Node.js 20 app`
- Use `Ctrl+L` to ask "What ports should I expose in docker-compose.prod.yml?"
- Cursor's `@Codebase` feature lets the AI understand your entire repo before answering
- Install extensions: **Docker** (Microsoft), **GitHub Actions**, and **YAML** in Cursor's Extension panel

---

<a name="section-2"></a>
## Section 2 — Dockerfile & Application Container

### 2.1 Writing the Dockerfile (Node.js Example)

The Dockerfile defines how your app is packaged. This multi-stage build keeps the final image lean — the builder stage installs dependencies, and the runner stage copies only what's needed for production.

```dockerfile
# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests first (layer caching optimization)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nodejs -u 1001

# Copy built artifacts from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs . .

# Switch to non-root user
USER nodejs

# Expose app port
EXPOSE 3000

# Health check (Docker will monitor this)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
```

> **Cursor AI Tip:** Type `// Dockerfile for Python FastAPI with gunicorn` as an inline comment and press `Ctrl+K` — Cursor will generate the entire Dockerfile tailored to your stack.

### 2.2 .dockerignore File

Prevents unnecessary files from being sent to the Docker build context, dramatically speeding up builds:

```
node_modules
.env
.env.*
!.env.example
.git
.gitignore
*.log
*.md
.github
docker-compose*.yml
coverage/
.nyc_output
dist/
*.test.js
*.spec.js
```

### 2.3 Local Docker Compose (Development)

Use this to verify your container works locally before pushing to CI:

```yaml
# docker-compose.yml  (development)
version: '3.9'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
      target: runner
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
    env_file:
      - .env
    volumes:
      - ./src:/app/src    # Hot reload in dev
    restart: unless-stopped

  # Optional: local database
  # db:
  #   image: postgres:15-alpine
  #   environment:
  #     POSTGRES_PASSWORD: dev_password
```

**Build and run locally:**

```bash
# Build and start
docker compose up --build

# Run in background
docker compose up -d --build

# View logs
docker compose logs -f app

# Stop everything
docker compose down
```

---

<a name="section-3"></a>
## Section 3 — GitHub Actions CI/CD Pipeline

### 3.1 Core Workflow File

This is the heart of the pipeline. Create `.github/workflows/deploy.yml` in your repository. Every push to `main` triggers: **test → build → push → deploy**.

```yaml
# .github/workflows/deploy.yml
name: CI/CD Pipeline — Build, Push & Deploy

on:
  push:
    branches: [ main, master ]
  pull_request:
    branches: [ main, master ]

env:
  # Docker Hub — change to your username/repo
  DOCKER_IMAGE: ${{ secrets.DOCKERHUB_USERNAME }}/my-app
  # OR for AWS ECR:
  # ECR_IMAGE: ${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.us-east-1.amazonaws.com/my-app

jobs:
  # ─── Job 1: Tests ──────────────────────────────────────────────────────────
  test:
    name: Run Tests
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Run linter
        run: npm run lint

  # ─── Job 2: Build & Push Docker Image ──────────────────────────────────────
  build-and-push:
    name: Build & Push Docker Image
    runs-on: ubuntu-latest
    needs: test                       # Only runs if tests pass
    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/master'

    outputs:
      image-tag: ${{ steps.meta.outputs.tags }}
      image-digest: ${{ steps.build.outputs.digest }}

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}

      - name: Extract Docker metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.DOCKER_IMAGE }}
          tags: |
            type=ref,event=branch
            type=sha,prefix=sha-
            type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}

      - name: Build and push Docker image
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha          # GitHub Actions cache
          cache-to: type=gha,mode=max

  # ─── Job 3: Deploy to Server ───────────────────────────────────────────────
  deploy:
    name: Deploy to Production
    runs-on: ubuntu-latest
    needs: build-and-push
    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/master'

    environment:
      name: production
      url: https://your-domain.com

    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SERVER_SSH_KEY }}
          port: ${{ secrets.SERVER_PORT || 22 }}
          script: |
            cd /opt/my-app

            # Pull latest image
            docker pull ${{ env.DOCKER_IMAGE }}:latest

            # Zero-downtime swap
            docker compose -f docker-compose.prod.yml up -d \
              --pull always \
              --no-deps \
              --force-recreate app

            # Remove dangling images
            docker image prune -f

            echo "Deployment complete: $(date)"

  # ─── Job 4: Notify on Failure ──────────────────────────────────────────────
  notify-on-failure:
    name: Notify on Failure
    runs-on: ubuntu-latest
    needs: [test, build-and-push, deploy]
    if: failure()
    steps:
      - name: Slack notification
        uses: rtCamp/action-slack-notify@v2
        env:
          SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK_URL }}
          SLACK_COLOR: '#FF0000'
          SLACK_MESSAGE: |
            Deployment FAILED on ${{ github.repository }}
            Branch: ${{ github.ref_name }}
            Commit: ${{ github.sha }}
            Author: ${{ github.actor }}
            See: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
```

### 3.2 GitHub Actions Secrets Configuration

Navigate to your GitHub repository → **Settings → Secrets and variables → Actions**. Add these secrets:

| Secret Name | Example Value | Description |
|---|---|---|
| `DOCKERHUB_USERNAME` | `your-username` | Docker Hub account username |
| `DOCKERHUB_TOKEN` | `dckr_pat_...` | Docker Hub access token (not password) |
| `SERVER_HOST` | `123.45.67.89` | DigitalOcean/EC2 public IP or hostname |
| `SERVER_USER` | `deploy` | SSH username on target server |
| `SERVER_SSH_KEY` | `-----BEGIN RSA...` | Private key (entire contents of `~/.ssh/id_rsa`) |
| `SERVER_PORT` | `22` | SSH port (optional, defaults to 22) |
| `SLACK_WEBHOOK_URL` | `https://hooks.slack.com/...` | Slack incoming webhook (optional) |

> **Generate a Docker Hub access token:** Docker Hub → Account Settings → Security → New Access Token. Use `Read & Write` scope.

### 3.3 AWS ECR Variant (Alternative to Docker Hub)

If using Amazon ECR instead of Docker Hub, replace the login and image reference steps:

```yaml
      # Replace Docker Hub login step with:
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1

      - name: Log in to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      # Update env.DOCKER_IMAGE to:
      # ${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.us-east-1.amazonaws.com/my-app

      # Add to Secrets:
      # AWS_ACCESS_KEY_ID         → IAM access key
      # AWS_SECRET_ACCESS_KEY     → IAM secret key
      # AWS_ACCOUNT_ID            → 12-digit AWS account ID
```

---

<a name="section-4"></a>
## Section 4 — Server Provisioning (DigitalOcean / EC2)

### 4.1 DigitalOcean Droplet Setup

Provision an **Ubuntu 22.04 LTS** Droplet. Minimum specs for a small app: **2 vCPU, 2GB RAM, 50GB SSD**.

Run these commands on the server as `root` after SSH-ing in:

```bash
# 1. Update packages
apt-get update && apt-get upgrade -y

# 2. Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# 3. Install Docker Compose plugin (v2)
apt-get install -y docker-compose-plugin

# 4. Create a dedicated deploy user (never deploy as root)
useradd -m -s /bin/bash deploy
usermod -aG docker deploy

# 5. Set up SSH key for GitHub Actions
mkdir -p /home/deploy/.ssh
# Paste your PUBLIC key (id_rsa.pub) into authorized_keys:
echo "ssh-rsa AAAA... your-public-key" >> /home/deploy/.ssh/authorized_keys
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh

# 6. Create application directory
mkdir -p /opt/my-app
chown deploy:deploy /opt/my-app

# 7. Install Nginx
apt-get install -y nginx
systemctl enable nginx
systemctl start nginx

# 8. Install Certbot for SSL
apt-get install -y certbot python3-certbot-nginx

# 9. Configure UFW firewall
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

### 4.2 AWS EC2 Setup

For EC2, use an **Ubuntu 22.04 AMI** (`ami-0c7217cdde317cfec` in us-east-1). The setup commands are identical to above, but configure the **Security Group inbound rules** in the AWS Console:

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 22 | TCP | Your IP | SSH access for initial setup |
| 80 | TCP | 0.0.0.0/0 | HTTP (redirects to HTTPS via Nginx) |
| 443 | TCP | 0.0.0.0/0 | HTTPS production traffic |

### 4.3 Production docker-compose.prod.yml on Server

Upload this file to `/opt/my-app/` on your server:

```yaml
# /opt/my-app/docker-compose.prod.yml
version: '3.9'

services:
  app:
    image: your-dockerhub-username/my-app:latest
    restart: always
    expose:
      - "3000"          # Internal only — Nginx proxies from outside
    environment:
      - NODE_ENV=production
    env_file:
      - .env.production
    networks:
      - web
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

networks:
  web:
    external: false
```

---

<a name="section-5"></a>
## Section 5 — Nginx Reverse Proxy Configuration

### 5.1 Initial Nginx Config (HTTP Only — Before SSL)

First configure Nginx for HTTP. Certbot will later modify this file to add SSL. Create the file at `/etc/nginx/sites-available/my-app`:

```nginx
# /etc/nginx/sites-available/my-app
# Step 1: HTTP only (Certbot will upgrade to HTTPS)

server {
    listen 80;
    listen [::]:80;
    server_name your-domain.com www.your-domain.com;

    # Let's Encrypt verification path
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # Proxy to Docker container
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Enable the site and reload Nginx
ln -s /etc/nginx/sites-available/my-app /etc/nginx/sites-enabled/
nginx -t                   # Test for syntax errors — must return "ok"
systemctl reload nginx
```

### 5.2 Obtaining SSL Certificate with Certbot

Point your domain's **A record** to your server IP first. Wait for DNS propagation (~5–10 minutes), then run:

```bash
# Obtain certificate and auto-configure Nginx
certbot --nginx -d your-domain.com -d www.your-domain.com

# Certbot will:
# 1. Verify domain ownership via HTTP challenge
# 2. Download certificate to /etc/letsencrypt/live/your-domain.com/
# 3. Modify your Nginx config to add SSL blocks
# 4. Set up auto-renewal cron job

# Test auto-renewal (do this immediately after setup)
certbot renew --dry-run

# Verify the renewal timer is active
systemctl status certbot.timer
```

### 5.3 Production Nginx Config (After SSL — Full Hardened Config)

After Certbot runs, enhance the config with performance and security headers:

```nginx
# /etc/nginx/sites-available/my-app  (after Certbot + security hardening)

# Rate limiting zone — 10 requests/second per IP
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

# HTTP → HTTPS redirect
server {
    listen 80;
    listen [::]:80;
    server_name your-domain.com www.your-domain.com;
    return 301 https://$host$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name your-domain.com www.your-domain.com;

    # SSL — managed by Certbot
    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header X-Frame-Options          "SAMEORIGIN" always;
    add_header X-XSS-Protection         "1; mode=block" always;
    add_header X-Content-Type-Options   "nosniff" always;
    add_header Referrer-Policy          "strict-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Content-Security-Policy  "default-src 'self'; script-src 'self' 'unsafe-inline';" always;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 1000;

    # Static files (if serving from filesystem)
    location /static/ {
        alias /opt/my-app/static/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # API / application proxy
    location / {
        limit_req zone=api burst=20 nodelay;

        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
    }
}
```

```bash
# After editing, always test and reload
nginx -t && systemctl reload nginx
```

---

<a name="section-6"></a>
## Section 6 — SSH Key Setup & Security

### 6.1 Generating the Deploy SSH Key Pair

Generate a **dedicated key pair** for GitHub Actions deployment. Do this on your **local machine**, not the server. Never reuse your personal SSH keys for automation.

```bash
# On your LOCAL machine — generate deploy key pair
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/deploy_key -N ""

# This creates two files:
#   ~/.ssh/deploy_key       → PRIVATE KEY (goes into GitHub Secrets as SERVER_SSH_KEY)
#   ~/.ssh/deploy_key.pub   → PUBLIC KEY (goes onto server's authorized_keys)

# View private key to copy into GitHub Secret:
cat ~/.ssh/deploy_key

# View public key to copy to server:
cat ~/.ssh/deploy_key.pub
```

```bash
# On the SERVER — add the public key to deploy user
su - deploy
mkdir -p ~/.ssh
echo "ssh-ed25519 AAAA... github-actions-deploy" >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys

# Test connection from your local machine:
ssh -i ~/.ssh/deploy_key deploy@your-server-ip 'echo Connection OK'
```

### 6.2 Hardening SSH on the Server

Edit `/etc/ssh/sshd_config`:

```bash
# /etc/ssh/sshd_config — security hardening

# Disable password authentication (keys only)
PasswordAuthentication no
ChallengeResponseAuthentication no

# Disable root login
PermitRootLogin no

# Only allow deploy user via SSH
AllowUsers deploy

# Use only modern key exchange algorithms
KexAlgorithms curve25519-sha256,diffie-hellman-group14-sha256

# Disable X11 forwarding
X11Forwarding no
```

```bash
# Restart SSH — TEST IN A NEW TERMINAL FIRST before closing your session!
systemctl restart sshd
```

> ⚠️ **Warning:** Always test your SSH connection in a **new terminal window** before closing the current session. If you make a mistake, you could lock yourself out.

---

<a name="section-7"></a>
## Section 7 — Environment Variables & Secrets Management

### 7.1 .env File Strategy

Never commit `.env` files to Git. Use `.env.example` as a template and manage actual values through GitHub Secrets (for CI) and a `.env.production` file on the server.

```bash
# .env.example  — commit this to Git (no real values)
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/mydb
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-here
API_KEY=your-api-key-here
```

```bash
# On server — set up production env file
su - deploy
cd /opt/my-app
cp .env.example .env.production
nano .env.production        # Fill in real values
chmod 600 .env.production   # Only owner can read/write
```

### 7.2 Passing Secrets at Deploy Time (Optional Pattern)

Alternatively, inject secrets at container startup via the GitHub Actions deploy step. This avoids keeping a `.env` file on the server:

```yaml
      # In deploy.yml — inject env vars directly from GitHub Secrets
      - name: Create env file on server
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SERVER_SSH_KEY }}
          script: |
            cat > /opt/my-app/.env.production << 'EOF'
            NODE_ENV=production
            DATABASE_URL=${{ secrets.DATABASE_URL }}
            JWT_SECRET=${{ secrets.JWT_SECRET }}
            API_KEY=${{ secrets.API_KEY }}
            EOF
            chmod 600 /opt/my-app/.env.production
```

---

<a name="section-8"></a>
## Section 8 — Zero-Downtime Deployment Strategy

### 8.1 How Zero-Downtime Works

The `--no-deps --force-recreate` flags ensure the old container serves traffic until the new one passes its health check. Docker's HEALTHCHECK endpoint is critical here.

```bash
# The deploy script explained step-by-step:

cd /opt/my-app

# 1. Pull new image BEFORE stopping old container
docker pull your-username/my-app:latest

# 2. Recreate ONLY the app service (not dependencies like databases)
#    --pull always     → always use freshly pulled image
#    --no-deps         → don't restart dependent services
#    --force-recreate  → replace container even if image tag hasn't changed
docker compose -f docker-compose.prod.yml up -d \
  --pull always \
  --no-deps \
  --force-recreate app

# 3. Verify the new container is healthy
sleep 10
docker compose -f docker-compose.prod.yml ps

# 4. Clean up old images to save disk space
docker image prune -f
```

### 8.2 Health Check Endpoint in Your App

Your application must expose a `/health` endpoint for Docker's `HEALTHCHECK` to work:

```javascript
// src/index.js — add health check endpoint

const express = require('express');
const app = express();

// Health check for Docker and load balancers
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    uptime: process.uptime(),
  });
});

// Your actual routes
app.get('/', (req, res) => res.send('Hello World'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
```

### 8.3 Automated Rollback on Health Check Failure

Add this to the deploy step script to auto-rollback if the new container isn't healthy:

```bash
          # After docker compose up — add health check loop:
          
          for i in $(seq 1 12); do
            STATUS=$(docker inspect --format='{{.State.Health.Status}}' \
              $(docker compose -f docker-compose.prod.yml ps -q app))
            if [ "$STATUS" = "healthy" ]; then
              echo "Health check passed on attempt $i"
              exit 0
            fi
            echo "Waiting for health... attempt $i/12"
            sleep 5
          done

          # Auto-rollback if still unhealthy after 60 seconds
          echo "Health check failed — rolling back!"
          docker compose -f docker-compose.prod.yml up -d \
            --no-deps --force-recreate app
          exit 1
```

---

<a name="section-9"></a>
## Section 9 — Monitoring & Observability

### 9.1 Essential Monitoring Commands

```bash
# ── Container Status ───────────────────────────────────────────────────────
docker ps                                        # Running containers
docker ps -a                                     # All containers (inc. stopped)
docker stats                                     # Live CPU/memory usage

# ── Application Logs ───────────────────────────────────────────────────────
docker compose -f /opt/my-app/docker-compose.prod.yml logs -f --tail=100 app

# ── Health Status ──────────────────────────────────────────────────────────
docker inspect --format='{{.State.Health.Status}}' $(docker ps -q)

# ── Nginx ──────────────────────────────────────────────────────────────────
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log

# ── SSL Certificate ────────────────────────────────────────────────────────
certbot certificates                             # Shows expiry dates

# ── Disk Usage (Docker fills disks over time) ──────────────────────────────
df -h
docker system df
docker system prune -a                           # Clean ALL unused resources
```

### 9.2 GitHub Actions Pipeline Badges

Add this to your `README.md` to show live pipeline status:

```markdown
![CI/CD Pipeline](https://github.com/YOUR_ORG/YOUR_REPO/actions/workflows/deploy.yml/badge.svg)
```

---

<a name="section-10"></a>
## Section 10 — Rollback Strategy

### 10.1 Rolling Back to a Previous Version

Docker image tags make rollback straightforward. Every build is tagged with the Git SHA (`sha-abc1234`), so you can always redeploy any previous version:

```bash
# On the server — manual rollback to a specific SHA tag

# 1. List available image tags
docker images your-username/my-app

# 2. Pull a specific SHA tag (get the SHA from GitHub Actions logs)
docker pull your-username/my-app:sha-abc1234

# 3. Deploy it using an environment variable override
IMAGE_TAG=sha-abc1234 docker compose -f docker-compose.prod.yml up -d \
  --no-deps --force-recreate app
```

For the `IMAGE_TAG` override to work, update `docker-compose.prod.yml`:

```yaml
services:
  app:
    image: your-username/my-app:${IMAGE_TAG:-latest}  # Falls back to latest
```

### 10.2 Tagging Releases for Easy Rollback

Add this optional job to create GitHub Releases with semantic version tags:

```yaml
  tag-release:
    name: Tag Release
    runs-on: ubuntu-latest
    needs: deploy
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - name: Create release tag
        run: |
          TAG="v$(date +%Y%m%d%H%M%S)-${GITHUB_SHA::7}"
          git tag $TAG
          git push origin $TAG
          echo "Tagged release: $TAG"
```

---

<a name="section-11"></a>
## Section 11 — Cursor AI Workflow Integration

### 11.1 Power Prompts for This Stack

| Cursor Feature | What to Type | What Cursor Generates |
|---|---|---|
| `Ctrl+K` inline | `// Dockerfile for Python FastAPI with gunicorn` | Complete production Dockerfile |
| `Ctrl+K` inline | `// GitHub Actions job to run pytest with coverage` | Full test job YAML |
| `Ctrl+L` chat | "Review this deploy.yml for security vulnerabilities" | Security audit with specific fixes |
| `Ctrl+L` chat | "Add Redis and PostgreSQL to my docker-compose.prod.yml" | Updated compose with both services |
| `@Codebase` | "How does my app connect to the database?" | Answer based on your actual code |
| `Ctrl+L` chat | "Write Nginx config for WebSocket support" | WebSocket-ready nginx.conf |

### 11.2 Recommended Cursor Extensions

- **Docker** (Microsoft) — Dockerfile syntax, compose validation, image explorer
- **GitHub Actions** — Workflow YAML syntax highlighting and marketplace integration
- **YAML** (Red Hat) — Full YAML language server with schema validation
- **Remote - SSH** (Microsoft) — Edit files on your server directly in Cursor
- **GitLens** — Git history, blame annotations, branch management
- **REST Client** — Test API endpoints inline (create `.http` files)
- **DotENV** — Syntax highlighting for `.env` files

### 11.3 Remote Server Editing via Cursor

Connect directly to your production server to edit Nginx configs and inspect Docker containers without leaving the IDE:

```bash
# ~/.ssh/config on your local machine — add this entry

Host revlek-production
  HostName your-server-ip
  User deploy
  IdentityFile ~/.ssh/deploy_key
  ServerAliveInterval 60

Host revlek-staging
  HostName your-staging-ip
  User deploy
  IdentityFile ~/.ssh/deploy_key
```

**In Cursor:**
1. `Ctrl+Shift+P` → "Remote-SSH: Connect to Host"
2. Select `revlek-production`
3. Open folder: `/opt/my-app`
4. Now edit files on the server as if they were local!

---

<a name="section-12"></a>
## Section 12 — Troubleshooting Reference

### 12.1 Common Issues & Solutions

| Issue | Likely Cause | Fix |
|---|---|---|
| `Permission denied (publickey)` | Wrong public key on server | Re-check `authorized_keys` and file permissions (700/600) |
| Docker build fails in CI | Missing `.dockerignore`, wrong `COPY` paths | Run `docker build . locally` first to debug |
| Container exits immediately | App crash on startup, missing env var | Run `docker logs <container-id>` to see the error |
| `502 Bad Gateway` from Nginx | App not running or wrong proxy port | Check `docker ps` and `proxy_pass` port matches `EXPOSE` |
| SSL cert not renewing | Port 80 blocked or Certbot not running | Run `certbot renew --dry-run` and check output |
| Deploy job fails with timeout | SSH key mismatch or firewall blocking | Manually SSH as deploy user to verify connectivity |
| Old image still running | `--force-recreate` not used | Add `--force-recreate` to `docker compose up` |
| `No space left on device` | Docker images filling disk | Run `docker system prune -a` to clean old images |
| `bind: address already in use` | Another process on port 3000 | Run `lsof -i :3000` to find and kill the process |
| GitHub Actions can't find secrets | Secret name typo | Secrets are case-sensitive — double-check names |

### 12.2 Debug Commands Cheat Sheet

```bash
# ── Docker ─────────────────────────────────────────────────────────────────
docker ps -a                            # All containers including stopped
docker logs <container-id> --tail 50   # Last 50 log lines
docker logs <container-id> -f          # Follow logs live
docker exec -it <container-id> sh      # Shell into running container
docker inspect <container-id>          # Full container metadata as JSON
docker system prune -a                 # Remove ALL unused resources

# ── Nginx ──────────────────────────────────────────────────────────────────
nginx -t                                # Test config for syntax errors
systemctl status nginx                  # Is Nginx running?
journalctl -u nginx -n 50             # Last 50 systemd logs
cat /var/log/nginx/error.log           # Error log

# ── SSL ────────────────────────────────────────────────────────────────────
openssl s_client -connect your-domain.com:443 -showcerts
curl -I https://your-domain.com        # Check response headers
certbot certificates                    # List certs and expiry dates
certbot renew --dry-run                # Test renewal without actually renewing

# ── GitHub Actions ─────────────────────────────────────────────────────────
# Navigate to: github.com/your-org/your-repo/actions
# Click the failed run → expand the failed step → read the logs
# Use "Re-run failed jobs" to retry without re-triggering everything
```

---

<a name="section-13"></a>
## Section 13 — Full Pre-Launch Checklist

### Repository & Code

- [ ] `Dockerfile` is present and builds successfully locally (`docker build . -t my-app`)
- [ ] `.dockerignore` excludes `node_modules`, `.env`, and `.git`
- [ ] Application has a working `/health` endpoint returning `200 OK`
- [ ] `.env.example` is committed with all required variable names (no values)
- [ ] `.github/workflows/deploy.yml` is in the repository and valid YAML
- [ ] `docker-compose.prod.yml` is uploaded to `/opt/my-app/` on the server

### GitHub Secrets

- [ ] `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (or AWS ECR equivalents) are set
- [ ] `SERVER_HOST`, `SERVER_USER`, and `SERVER_SSH_KEY` are configured
- [ ] All application-level secrets (`DATABASE_URL`, `JWT_SECRET`, etc.) are added

### Server

- [ ] Docker and Docker Compose v2 (`docker compose version`) are installed
- [ ] `deploy` user exists and is in the `docker` group (`groups deploy`)
- [ ] SSH public key is in `/home/deploy/.ssh/authorized_keys`
- [ ] `/opt/my-app` directory exists and is owned by `deploy`
- [ ] `.env.production` is on the server and `chmod 600`
- [ ] UFW firewall allows ports `22`, `80`, and `443` (`ufw status`)

### Nginx & SSL

- [ ] Nginx site config is in `/etc/nginx/sites-available/` and symlinked to `sites-enabled/`
- [ ] `nginx -t` returns no errors
- [ ] Domain DNS A record points to server IP (verify with `dig your-domain.com`)
- [ ] SSL certificate obtained via `certbot --nginx`
- [ ] HTTPS redirect (HTTP → HTTPS) is working (`curl -I http://your-domain.com`)
- [ ] `certbot renew --dry-run` passes without errors

### End-to-End Test

- [ ] Push a commit to `main` branch
- [ ] All 3 GitHub Actions jobs go green (test → build-and-push → deploy)
- [ ] Visit `https://your-domain.com` and confirm the application loads
- [ ] `docker ps` on server shows container in `healthy` state
- [ ] SSL certificate is valid (green padlock in browser)

---

## Quick Reference

```bash
# ── Deploy manually (emergency) ────────────────────────────────────────────
ssh deploy@your-server-ip
cd /opt/my-app
docker pull your-username/my-app:latest
docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps app

# ── Rollback to specific SHA ────────────────────────────────────────────────
IMAGE_TAG=sha-abc1234 docker compose -f docker-compose.prod.yml up -d \
  --force-recreate --no-deps app

# ── View live logs ──────────────────────────────────────────────────────────
docker compose -f docker-compose.prod.yml logs -f --tail=100 app

# ── Restart Nginx ───────────────────────────────────────────────────────────
nginx -t && systemctl reload nginx

# ── Renew SSL ──────────────────────────────────────────────────────────────
certbot renew
```

---

*Revlek DevOps — CI/CD Pipeline Implementation Guide*  
*GitHub Actions • Docker • Docker Hub / AWS ECR • DigitalOcean / EC2 • Nginx • Let's Encrypt SSL • Cursor AI IDE*
