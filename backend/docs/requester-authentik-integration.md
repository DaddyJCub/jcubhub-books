# Future: Authentik (OIDC) Integration for Requesters

This documents how to swap the email-link provider for Authentik **without changing
the requester API contracts** (`/api/requester/*`) or the dashboard UI. The auth
provider abstraction (`requesterAuthProvider`) is the single seam.

## Selection

`REQUESTER_AUTH_PROVIDER=authentik` selects an `authentikProvider` that implements the
same interface as `emailLinkProvider` (`startLogin`, `verifyLink`/callback, `getSession`,
`logout`). Today that value logs a warning and falls back to `email_link` until the
provider is implemented.

## Required Authentik / OIDC configuration

Create an **OAuth2/OpenID Provider** + **Application** in Authentik, then set:

| Env var | Description |
| ------- | ----------- |
| `AUTHENTIK_ISSUER_URL` | OIDC issuer, e.g. `https://auth.example.com/application/o/jcubhub-books/` |
| `AUTHENTIK_CLIENT_ID` | Application client ID |
| `AUTHENTIK_CLIENT_SECRET` | Application client secret |
| `AUTHENTIK_REDIRECT_URI` | `https://books.example.com/requester/auth/callback` |
| `AUTHENTIK_SCOPES` | `openid email profile` (must include `email`) |

Authentik endpoints come from the issuer's `/.well-known/openid-configuration`
(`authorization_endpoint`, `token_endpoint`, `jwks_uri`, `end_session_endpoint`).

## Callback route mapping

Reuse the existing route `GET /requester/auth/callback`:

- **email_link (now):** `?token=<magic token>` → verify → set session cookie → redirect to dashboard.
- **authentik (later):** `?code=<authorization code>&state=<state>` → exchange code at
  `token_endpoint` → validate ID token against `jwks_uri` → read the `email` claim →
  `createRequesterSession(email, req)` → set the **same** session cookie → redirect to dashboard.

Because both providers terminate at `createRequesterSession` and the same
`jcub_requester_session` cookie, the dashboard, ownership checks, and all
`/api/requester/*` endpoints are unchanged.

## Token claims mapping

| Requester identity field | OIDC claim |
| ------------------------ | ---------- |
| `email` (primary key for request ownership) | `email` (require `email_verified = true`) |

The `email` claim must be normalized (`normalizeRequesterEmail`) before session creation
so it matches existing `requests.requester_email` grouping (ASSUMPTION-003).

## Migration steps (email-link → Authentik)

1. Configure the Authentik provider/application and the env vars above.
2. Deploy the `authentikProvider` implementation (new code; no contract change).
3. Add the Authentik domain to the CSP `connectSrc`/`formAction` allowlist if redirect
   flows require it.
4. Flip `REQUESTER_AUTH_PROVIDER=authentik`.
5. Existing requester sessions remain valid until they expire; magic-link tables can be
   retained for rollback or pruned once stable.
6. Rollback = set `REQUESTER_AUTH_PROVIDER=email_link` (no schema change needed).

## Notes

- Keep `requester_sessions` as the session store for both providers — it is provider-agnostic.
- `requester_magic_links` is only used by `email_link`; it is harmless to leave in place.
- No requester-facing URL changes are required by the migration.
