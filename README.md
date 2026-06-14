# JcubHub Books

A unified book request & library portal: a public request form, admin dashboard, and a
**requester dashboard** with passwordless email-link sign-in and metadata-rich book cards.
Single Node.js + Express + better-sqlite3 server serving static HTML/CSS/JS.

- Backend: [`backend/server.js`](backend/server.js)
- Public site: [`backend/public/index.html`](backend/public/index.html)
- Admin: `/admin`
- Requester dashboard: `/requester/login`
- Docker/Unraid setup: [`DOCKER_SETUP.md`](DOCKER_SETUP.md)

## Features

### Public request flow
- Submit a book request (name, email, title, author, ISBN, format).
- **Metadata-first search** (Open Library / Google Books): search by title/author/ISBN and
  click **Use this book** to autofill the form. Manual entry still works as a fallback.
- CWA availability check, Readarr auto-add, status tracking by token or request ID + email.

### Requester dashboard (`/requester/*`)
- **Passwordless email-link auth** — enter your email, receive a one-time sign-in link.
- Lists all requests for your email with live status, history, and ready-to-read links.
- Metadata-rich cards: cover, ISBN/year/publisher chips, expandable summary.
- Filters (status + has-cover / has-summary / missing-ISBN), live search, sort, CSV export.
- Reuse of request actions: send-to-eReader and match feedback, scoped to your ownership.
- Built behind an auth-provider abstraction so **Authentik (OIDC)** can replace email links
  later without changing the API — see
  [`backend/docs/requester-authentik-integration.md`](backend/docs/requester-authentik-integration.md).

## Running

```bash
cd backend
npm install        # requires native build toolchain for better-sqlite3 (or use Docker)
npm run start      # http://localhost:3003
npm test           # integration tests (node:test) — needs better-sqlite3 built
```

Docker is the recommended runtime (no local build tools needed): see
[`docker-compose.yml`](docker-compose.yml) and [`DOCKER_SETUP.md`](DOCKER_SETUP.md).

## Environment variables

### Core
| Var | Default | Purpose |
| --- | ------- | ------- |
| `PORT` | `3003` | HTTP port |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `DATA_PATH` | `backend/data` | SQLite directory (mount a volume in Docker) |
| `JWT_SECRET` | random | Admin JWT signing key |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | — | Seed admin account on first boot |
| `ADMIN_EMAIL` | — | Admin notification recipient |
| `ZOHO_EMAIL` / `ZOHO_PASSWORD` | — | SMTP (Zoho) for all outbound email |
| `TURNSTILE_SECRET_KEY` | — | Cloudflare Turnstile (captcha skipped if unset) |
| `READARR_URL` / `READARR_API_KEY` | — | Readarr/Chaptarr integration |
| `CWA_URL` / `CWA_USERNAME` / `CWA_PASSWORD` | — | Calibre-Web-Automated availability |
| `PUBLIC_URL` | derived from request | Base URL used in magic-link emails |

### Requester auth
| Var | Default | Purpose |
| --- | ------- | ------- |
| `REQUESTER_AUTH_PROVIDER` | `email_link` | `email_link` \| `authentik` (Authentik not yet wired) |
| `REQUESTER_MAGIC_LINK_TTL_MIN` | `15` | Magic-link lifetime (minutes) |
| `REQUESTER_SESSION_TTL_HOURS` | `336` | Session lifetime (hours) |
| `REQUESTER_SESSION_COOKIE` | `jcub_requester_session` | Session cookie name |
| `REQUESTER_COOKIE_SECURE` | `true` in prod | Force `Secure` cookie flag |
| `REQUESTER_AUTH_EXPOSE_TOKEN` | `false` | **Test only** — echoes raw magic token in start response (ignored in production) |

### Metadata providers
| Var | Default | Purpose |
| --- | ------- | ------- |
| `METADATA_PROVIDER` | `openlibrary` | Primary provider (`openlibrary` \| `googlebooks`) |
| `OPENLIBRARY_URL` | `https://openlibrary.org` | Open Library base URL |
| `GOOGLE_BOOKS_API_KEY` | — | Optional Google Books key (enables fallback/primary) |
| `GOOGLE_BOOKS_URL` | `https://www.googleapis.com/books/v1` | Google Books base URL |
| `METADATA_CACHE_TTL_MS` | `86400000` | Metadata cache TTL (24 h) |
| `METADATA_HTTP_TIMEOUT_MS` | `8000` | Per-request provider timeout |

### eReader send
| Var | Default | Purpose |
| --- | ------- | ------- |
| `EREADER_SEND_ENABLED` | `false` | Enable send-to-eReader |
| `EREADER_ALLOWED_DOMAINS` | — | Comma-separated allowlist (e.g. `kindle.com`) |

## API surface (requester)

| Method | Path | Auth | Notes |
| ------ | ---- | ---- | ----- |
| POST | `/api/requester/auth/start` | — | Always 200, generic message |
| GET | `/api/requester/auth/verify` | — | Sets cookie, 302 → dashboard (also `/requester/auth/callback`) |
| POST | `/api/requester/auth/logout` | session | Revoke session |
| GET | `/api/requester/me` | session | Identity |
| GET | `/api/requester/dashboard` | session | Counts + items (scoped to email) |
| GET | `/api/requester/requests/:id/history` | session | Owned request timeline |
| POST | `/api/requester/requests/:id/send-ereader` | session | Owned |
| POST | `/api/requester/requests/:id/feedback` | session | Owned |
| GET | `/api/requester/dashboard/export.csv` | session | Owner rows only |
| GET | `/api/metadata/search?q=&limit=` | — | Cached, rate-limited |

Contracts: [`requester-auth-contract.md`](backend/docs/requester-auth-contract.md) ·
[`requester-metadata-contract.md`](backend/docs/requester-metadata-contract.md).

## Operational runbook

- **Schema migrations** are additive and run automatically at startup in `initDatabase()`
  (existing `requests`/`status_history` data is preserved). No manual migration step.
- **Cleanup job** (`cleanupRequesterAuthArtifacts`) runs at startup and hourly to purge
  expired/used magic links, expired/revoked sessions, and stale metadata cache rows.
- **Email deliverability:** if magic links don't arrive, verify `ZOHO_*` SMTP creds and use
  the dashboard **Resend Login Link** action. Login is purely email-gated.
- **Behind a reverse proxy:** the app sets `trust proxy`. Ensure the proxy forwards
  `X-Forwarded-Proto` so `Secure` cookies and `PUBLIC_URL` derivation work; set `PUBLIC_URL`
  explicitly if links render with the wrong host.
- **Smoke tests:** [`requester-auth-smoke.md`](backend/docs/requester-auth-smoke.md) and
  [`requester-dashboard.ui-smoke.md`](backend/tests/requester-dashboard.ui-smoke.md).
