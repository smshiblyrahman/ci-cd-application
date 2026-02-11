# NestJS + Docker + GitHub Actions CI/CD

This repository contains a minimal **NestJS** HTTP API that is ready to be containerized and deployed using the workflow described in `cicd_pipeline_guide.md`.

## What you get

- **NestJS API** listening on `PORT` (default `3000`)
- **Health check endpoint** at `GET /health` (used by Docker health checks)
- **CI** (tests + lint) and **CD** (build/push image + deploy over SSH) via GitHub Actions
- **Dockerfile** (multi-stage) for production-ready images
- **Docker Compose** for local (`docker-compose.yml`) and server (`docker-compose.prod.yml`)
- **Nginx reverse proxy config template** at `docker/nginx/default.conf` (optional)

## Project structure

```
.
├── .github/workflows/deploy.yml
├── docker/nginx/default.conf
├── src/
│   ├── app.controller.ts
│   ├── app.module.ts
│   ├── health.controller.ts
│   └── main.ts
├── test/app.spec.ts
├── Dockerfile
├── docker-compose.yml
├── docker-compose.prod.yml
├── .dockerignore
├── .env.example
├── eslint.config.js
├── jest.config.ts
├── package.json
├── package-lock.json
├── tsconfig.json
└── tsconfig.build.json
```

## Requirements

- **Node.js**: recommended `20.x` (CI uses Node 20)
- **npm**: any modern npm that supports lockfile v3 (CI uses the npm bundled with Node 20)
- **Docker**: Docker Desktop (macOS/Windows) or Docker Engine (Linux) for container builds/runs

## Environment variables

This project reads:

- **`PORT`**: HTTP port to listen on (default `3000`)
- **`NODE_ENV`**: `development` or `production`

Copy the template and customize:

```bash
cp .env.example .env
```

> Do **not** commit `.env` or `.env.production`. Commit only `.env.example`.

## Local development (no Docker)

```bash
npm ci
npm run start:dev
```

Endpoints:

- `GET /` → hello message
- `GET /health` → health JSON + uptime

## Tests, lint, build

```bash
npm test
npm run lint
npm run build
npm start
```

## Docker

### Build image

```bash
docker build . -t project6:local
```

> If you see “Cannot connect to the Docker daemon…”, start Docker Desktop (macOS/Windows) or the Docker service (Linux).

### Run container

```bash
docker run --rm -p 3000:3000 --env PORT=3000 project6:local
```

### Local compose

```bash
docker compose up --build
```

## CI/CD (GitHub Actions)

Workflow: `.github/workflows/deploy.yml`

On push / PR:

- **Test job**: `npm ci` → `npm test` → `npm run lint`

On push to `main` / `master`:

- **Build & push**: builds the Docker image and pushes to Docker Hub using tags:
  - `latest`
  - `sha-<commit>`
- **Deploy**: SSH into your server and runs:
  - `docker pull <image>:latest`
  - `docker compose -f docker-compose.prod.yml up -d --pull always --no-deps --force-recreate app`

### Required GitHub Secrets

Add these in **Repo → Settings → Secrets and variables → Actions**:

- **`DOCKERHUB_USERNAME`**: your Docker Hub username
- **`DOCKERHUB_TOKEN`**: Docker Hub access token (Read/Write)
- **`SERVER_HOST`**: server IP/hostname
- **`SERVER_USER`**: SSH user (recommended: `deploy`)
- **`SERVER_SSH_KEY`**: private key contents for the deploy user
- **`SERVER_PORT`**: optional (defaults to `22`)

## Production deployment (server)

The guide assumes:

- App directory: **`/opt/my-app`**
- Compose file on server: **`/opt/my-app/docker-compose.prod.yml`**
- Env file on server: **`/opt/my-app/.env.production`**

### Server-side setup (high level)

Follow the full step-by-step checklist in:

- `cicd_pipeline_guide.md`

At minimum, your server must have:

- Docker + Compose plugin (`docker compose version`)
- A deploy user in the `docker` group
- Nginx reverse proxy (ports `80`/`443`) with Let’s Encrypt certs (Certbot)

### Configure the image in `docker-compose.prod.yml`

`docker-compose.prod.yml` uses:

- `DOCKER_IMAGE` (defaults to `your-dockerhub-username/project6`)
- `IMAGE_TAG` (defaults to `latest`)

Example on server:

```bash
export DOCKER_IMAGE="YOUR_DOCKERHUB_USERNAME/project6"
export IMAGE_TAG="latest"
docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate app
```

### Rollback

Because CI pushes SHA tags, you can roll back by setting `IMAGE_TAG`:

```bash
IMAGE_TAG=sha-<commit> docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate app
```

## Nginx

For a basic reverse proxy, point Nginx to your app at `127.0.0.1:3000` (or to the container network if using a dockerized Nginx).

- Local template: `docker/nginx/default.conf`
- Hardened SSL setup + headers: see `cicd_pipeline_guide.md` (Section 5)

## Notes

- The Docker image defines a `HEALTHCHECK` that calls `GET /health`. Make sure Nginx and your deployment strategy allow the service to become healthy before routing traffic.

