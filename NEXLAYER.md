# Nexlayer — s12ryt-tg-api

<!-- nexlayer:meta version=1 analyzed=2026-07-20T15:10:22Z repo=https://github.com/s12ryt/s12ryt-tg-api branch=main -->

> **For AI agents (Claude Code, Cursor, Gemini CLI, Copilot):**
> This file is the **project context** for this Nexlayer deployment — tech stack, env vars, secrets, live URL.
> For full platform detail (nexlayer.yaml schema, Dockerfile rules, CI/CD, task recipes) read **`nexlayer.skills`** in this repo.
>
> **Critical rules (full detail in `nexlayer.skills`):**
> - Inter-pod refs: `${podName:port}` only — never `localhost` or bare hostnames
> - Docker Hub images: prefix with `mirror.gcr.io/library/` — bare tags fail on the cluster
> - Secrets: set in the Nexlayer dashboard — never commit to `nexlayer.yaml` or Dockerfile
>
> **This file:** `agent-managed` sections update automatically. `user-editable` sections (Local Development Setup, Nexlayer Deployment Plan, Build Notes) are yours — preserved across re-analysis.

## Project Summary
<!-- nexlayer:section agent-managed=project_summary -->
An AI API aggregation proxy service that provides OpenAI and Anthropic compatible endpoints, managed via a Telegram Bot and Web console with support for multi-provider failover, usage quotas, and a Node.js plugin system.
<!-- nexlayer:end -->

## Technology Stack
<!-- nexlayer:section agent-managed=tech_stack -->
| Name | Kind | Version | Detected From |
|------|------|---------|---------------|
| Node.js | language | 24 | .nvmrc, Dockerfile |
| TypeScript | language | Not specified | Dockerfile |
| SQLite/PostgreSQL | database | 16 (Postgres) | docker-compose.yml |
<!-- nexlayer:end -->

## Repository Structure
<!-- nexlayer:section agent-managed=structure_map -->
- nodejs/ — Main application logic and API source
- nodejs/dist — Compiled production build
- nodejs/web — Web administration console assets
- nodejs/scripts — Operational and setup scripts
- nodejs/data — Local SQLite database storage
<!-- nexlayer:end -->

## External Services Required
<!-- nexlayer:section agent-managed=external_deps -->
Services that must be configured separately (not deployed by Nexlayer):

- Telegram Bot API (BOT_TOKEN)
- AI Providers (OpenAI, Anthropic, Google)
<!-- nexlayer:end -->

## Local Development Setup
<!-- nexlayer:section user-editable=local_setup -->
### Prerequisites

- Node.js >= 22
- npm

### Environment variables

Copy `.env.example` to `.env.local` and fill in:

```
BOT_TOKEN=your_telegram_bot_token
ADMIN_ID=your_telegram_user_id
API_PORT=8000
DEFAULT_API_URL=http://localhost:8000
```

### Steps

1. `cd nodejs && npm install` — Install dependencies
2. `cp nodejs/.env.example nodejs/.env` — Setup environment variables
3. `npm run dev` — Start the application in development mode

<!-- nexlayer:end -->

## Nexlayer Setup
<!-- nexlayer:section agent-managed=nexlayer_setup -->
### Pod Environment Variables

| Pod | Variable | Value | Kind |
|-----|----------|-------|------|
| `app` | `NODE_ENV` | `production` | plain |
| `app` | `API_PORT` | `"8000"` | plain |
| `app` | `BOT_TOKEN` | `"${BOT_TOKEN}"` | inter-pod |
| `app` | `ADMIN_ID` | `${ADMIN_ID}` | inter-pod |
| `app` | `DATABASE_URL` | `"postgresql://app:${POSTGRES_PASSWORD}@postgres.pod:5432/app"` | inter-pod |
| `app` | `DATABASE_PATH` | `"/app/nodejs/data/bot.db"` | plain |
| `app` | `DEFAULT_API_URL` | `"<% URL %>"` | plain |
| `app` | `NODEJS_PLUGIN_PATHS` | `${NODEJS_PLUGIN_PATHS}` | inter-pod |
| `app` | `CLOUDFLARE_TUNNEL` | `${CLOUDFLARE_TUNNEL}` | inter-pod |
| `app` | `CLOUDFLARE_TOKEN` | `"${CLOUDFLARE_TOKEN}"` | inter-pod |
| `app` | `GITHUB_MIRROR` | `${GITHUB_MIRROR}` | inter-pod |
| `app` | `NPM_REGISTRY` | `${NPM_REGISTRY}` | inter-pod |
| `postgres` | `POSTGRES_USER` | `"app"` | plain |
| `postgres` | `POSTGRES_PASSWORD` | `${POSTGRES_PASSWORD}` | inter-pod |
| `postgres` | `POSTGRES_DB` | `"app"` | plain |
| `s12ryt-tg-api-postgres-data` | `size` | `10Gi` | plain |
| `s12ryt-tg-api-postgres-data` | `mountPath` | `/var/lib/postgresql/data` | plain |

### nexlayer.yaml

```yaml
application:
  name: s12ryt-tg-api
  pods:
    - name: app
      image: "registry.nexlayer.io/user_01ky00q4y1ar9h96b4vqxnbjet/s12ryt-tg-api:19f801397df"
      path: /
      servicePorts:
        - 8000
      vars:
        NODE_ENV: production
        API_PORT: "8000"
        BOT_TOKEN: "${BOT_TOKEN}"
        ADMIN_ID: ${ADMIN_ID}
        DATABASE_URL: "postgresql://app:${POSTGRES_PASSWORD}@postgres.pod:5432/app"
        DATABASE_PATH: "/app/nodejs/data/bot.db"
        DEFAULT_API_URL: "<% URL %>"
        NODEJS_PLUGIN_PATHS: ${NODEJS_PLUGIN_PATHS}
        CLOUDFLARE_TUNNEL: ${CLOUDFLARE_TUNNEL}
        CLOUDFLARE_TOKEN: "${CLOUDFLARE_TOKEN}"
        GITHUB_MIRROR: ${GITHUB_MIRROR}
        NPM_REGISTRY: ${NPM_REGISTRY}
    - name: postgres
      image: mirror.gcr.io/library/postgres:16-alpine
      servicePorts:
        - 5432
      vars:
        POSTGRES_USER: "app"
        POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
        POSTGRES_DB: "app"
      volumes:
        - name: s12ryt-tg-api-postgres-data
          size: 10Gi
          mountPath: /var/lib/postgresql/data
```

<!-- nexlayer:end -->

## Nexlayer Deployment Plan
<!-- nexlayer:section user-editable=deployment_plan -->
### Pod Topology

| Pod | Image | Port | Role |
|-----|-------|------|------|
| api | mirror.gcr.io/library/node:24-bookworm-slim | 8000 | web |
| db | mirror.gcr.io/library/postgres:16 | 5432 | database |

### Deployment notes

- The API pod communicates with the database using the address db.pod:5432
- The DEFAULT_API_URL is set to api.pod:8000 to maintain internal Nexlayer pod communication standards
- The application supports both SQLite (file-based) and PostgreSQL; for Nexlayer, a separate PostgreSQL pod is required per Rule 4

<!-- nexlayer:end -->

## Build Notes
<!-- nexlayer:section user-editable=build_notes -->
<!-- Add notes for future builds here — preserved across re-analysis -->
<!-- nexlayer:end -->

## Nexlayer Configuration
<!-- nexlayer:section agent-managed=nexlayer_config -->
**Last deployed:** 2026-07-20T15:18:59Z  
**Live URL:** https://precise-sloth-s12ryt-tg-api.cloud.nexlayer.ai  
**Runtime:** node · **Port:** 8000  
**Deploy branch:** main  

```yaml
application:
  name: s12ryt-tg-api
  pods:
    - name: app
      image: "registry.nexlayer.io/user_01ky00q4y1ar9h96b4vqxnbjet/s12ryt-tg-api:19f801397df"
      path: /
      servicePorts:
        - 8000
      vars:
        NODE_ENV: production
        API_PORT: "8000"
        BOT_TOKEN: "${BOT_TOKEN}"
        ADMIN_ID: ${ADMIN_ID}
        DATABASE_URL: "postgresql://app:${POSTGRES_PASSWORD}@postgres.pod:5432/app"
        DATABASE_PATH: "/app/nodejs/data/bot.db"
        DEFAULT_API_URL: "<% URL %>"
        NODEJS_PLUGIN_PATHS: ${NODEJS_PLUGIN_PATHS}
        CLOUDFLARE_TUNNEL: ${CLOUDFLARE_TUNNEL}
        CLOUDFLARE_TOKEN: "${CLOUDFLARE_TOKEN}"
        GITHUB_MIRROR: ${GITHUB_MIRROR}
        NPM_REGISTRY: ${NPM_REGISTRY}
    - name: postgres
      image: mirror.gcr.io/library/postgres:16-alpine
      servicePorts:
        - 5432
      vars:
        POSTGRES_USER: "app"
        POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
        POSTGRES_DB: "app"
      volumes:
        - name: s12ryt-tg-api-postgres-data
          size: 10Gi
          mountPath: /var/lib/postgresql/data
```
<!-- nexlayer:end -->

## Build History
<!-- nexlayer:section agent-managed=build_history -->
| Date | Status | Notes |
|------|--------|-------|
| 2026-07-20T15:10:22Z | analyzed | initial repo analysis |
| 2026-07-20T15:18:59Z | success | deployed https://precise-sloth-s12ryt-tg-api.cloud.nexlayer.ai |
<!-- nexlayer:end -->
