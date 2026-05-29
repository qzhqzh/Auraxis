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

## LAN Demo Access

Gateway is published by Docker Compose on `0.0.0.0:${GATEWAY_PORT:-3000}`. The demo host should also bind to all interfaces for remote browser testing:

```bash
DEMO_HOST=0.0.0.0 DEMO_PORT=5174 bun run dev:demo
```

Open the demo from another device with the server machine IP:

```text
http://<server-lan-ip>:5174/
http://<server-lan-ip>:5174/console.html
```

The demo config derives Gateway URL from the request hostname, so opening `http://<server-lan-ip>:5174/` makes the browser call `http://<server-lan-ip>:${GATEWAY_PORT:-3000}`. Make sure the firewall allows both the demo port and Gateway port.

## Notes

- PostgreSQL data is stored with a bind mount at `.data/postgres`; this project does not use Docker volumes.
- DeepSeek credentials are configured through `.env`; do not commit real API keys.


## Codex Handoff

When continuing work in a fresh Codex session, start with [codex-handoff.md](./codex-handoff.md). It records the current branch, recent commits, local startup commands, verification commands, and the recommended next task.
