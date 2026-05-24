# Auraxis Development

## Prerequisites

- Docker Compose

Node.js and bun are only needed for optional host-side development. The default local workflow runs the app through Docker Compose.

## Local Setup

```bash
cp .env.example .env
docker compose up gateway
```

Gateway health check:

```bash
curl http://localhost:${GATEWAY_PORT:-3000}/v1/health
```

If the default host port is already in use, change `GATEWAY_PORT` in `.env`.

Database commands:

```bash
docker compose run --rm gateway bun run db:generate
docker compose run --rm gateway bun run db:migrate
```

## Notes

- PostgreSQL data is stored with a bind mount at `.data/postgres`; this project does not use Docker volumes.
- DeepSeek credentials are configured through `.env`; do not commit real API keys.
