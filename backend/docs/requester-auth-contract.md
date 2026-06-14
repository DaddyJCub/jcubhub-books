# Requester Authentication Contract

Passwordless, email-link ("magic link") authentication for the requester dashboard.
The implementation lives behind a provider interface (`requesterAuthProvider` in
`backend/server.js`) so Authentik (OIDC) can replace it later **without changing any of
the requester API contracts below**. See `requester-authentik-integration.md`.

## Provider interface

`requesterAuthProvider` exposes:

| Method | Signature | Purpose |
| ------ | --------- | ------- |
| `startLogin` | `(email, req) → { token, expiresAt, email }` | Create a hashed one-time magic token for the (normalized) email. Caller emails the link; the raw token is never persisted. |
| `verifyLink` | `(token, req) → { ok, email?, sessionToken?, expiresAt?, reason? }` | Validate a one-time token, mark it used, and create a session. `reason ∈ { invalid, used, expired }` on failure. |
| `createSession` | (internal helper `createRequesterSession(email, req)`) | Insert a session row, return the raw session token (returned to caller exactly once). |
| `getSession` | `(req) → { id, email, expiresAt } | null` | Resolve the active (non-expired, non-revoked) session from the request cookie. |
| `logout` | `(req) → boolean` | Revoke the current session. |

The current implementation is `emailLinkProvider` (`name: "email_link"`). Provider
selection is controlled by `REQUESTER_AUTH_PROVIDER` (`email_link` | `authentik`).

## Token & session lifetimes

| Item | Default | Env var | Notes |
| ---- | ------- | ------- | ----- |
| Magic link TTL | 15 min | `REQUESTER_MAGIC_LINK_TTL_MIN` | One-time use; hashed (SHA-256) at rest. |
| Session TTL | 336 h (14 d) | `REQUESTER_SESSION_TTL_HOURS` | Session token hashed (SHA-256) at rest. |
| Session cookie | `jcub_requester_session` | `REQUESTER_SESSION_COOKIE` | `HttpOnly`, `SameSite=Lax`, `Secure` in production. |

Cleanup of expired/used magic links and expired/revoked sessions runs at startup and
hourly via `cleanupRequesterAuthArtifacts()`.

## HTTP contracts

### `POST /api/requester/auth/start`

Request:
```json
{ "email": "reader@example.com" }
```
Response — **always `200`** with a generic message (anti-enumeration, SEC-004):
```json
{ "success": true, "message": "If that email has any requests, a sign-in link has been sent." }
```
- Rate limited by `IP + normalized email` (10 / 15 min).
- In non-production test mode (`REQUESTER_AUTH_EXPOSE_TOKEN=true` and `NODE_ENV != production`),
  the response also includes `"devToken": "<raw token>"` so automated tests can complete verify.

### `GET /api/requester/auth/verify?token=<token>`

Also reachable as the email link target `GET /requester/auth/callback?token=<token>`
(same handler).
- Valid token → marks token used, creates session, sets the session cookie, `302 → /requester/dashboard`.
- Invalid/used/expired → `302 → /requester/login?error=<invalid|used|expired>`.
- Missing token → `400`.

### `POST /api/requester/auth/logout`

Revokes the current session and clears the cookie.
```json
{ "success": true }
```

### `GET /api/requester/me` (protected)

```json
{ "email": "reader@example.com", "authProvider": "email_link", "sessionTtlHours": 336 }
```
Returns `401 { "error": "Requester authentication required" }` when unauthenticated.

## Security properties

- **SEC-001**: Magic tokens are 256-bit random, SHA-256 hashed at rest, single-use, 15 min default.
- **SEC-002**: Session cookies are `HttpOnly`; `Secure` + `SameSite=Lax` in production.
- **SEC-003**: `auth/start` and `auth/verify` are rate limited (start also keyed by email).
- **SEC-004**: `auth/start` returns a uniform `200` for known and unknown emails.
- Admin JWT auth (`authenticateToken`) and requester session auth
  (`authenticateRequesterSession`) are fully isolated — different stores, cookies, and middleware.
