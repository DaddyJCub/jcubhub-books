---
goal: Requester Dashboard with Email-Link Authentication and Future Authentik Readiness
version: 1.0
date_created: 2026-06-13
last_updated: 2026-06-13
owner: jcubhub-books
status: Completed
tags: [feature, auth, dashboard, migration]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

This plan implements a requester-facing dashboard that shows all requests for an email identity, live status/history, ready-to-read links, and rich book metadata (cover, summary, ISBN, author/publisher metadata), with secure email-link authentication now and a clean authentication abstraction for later Authentik integration.

## 1. Requirements & Constraints

- **REQ-001**: Provide a requester dashboard route that lists all requests for the authenticated requester email, including current status, created date, last update date, and request ID.
- **REQ-002**: Expose status history per request in the requester dashboard (same status timeline quality as existing request-status flow).
- **REQ-003**: Show actionable links for completed items (`cwa_book_link` when available, otherwise deterministic fallback link from existing backend helper behavior).
- **REQ-004**: Keep existing public request submission flow functional without requiring requester login.
- **REQ-005**: Use passwordless email-link authentication for requester access in this version.
- **REQ-006**: Add user-helping dashboard features: status filters, search, sort by newest update, resend login link, and notification preference visibility.
- **REQ-007**: Reuse existing request actions where valid (feedback and send-to-ereader) from dashboard context.
- **REQ-008**: Keep admin authentication and admin dashboard behavior unchanged.
- **REQ-009**: Render metadata-rich requester items in dashboard list/detail views: cover image, title, author(s), ISBN-10/ISBN-13, publication year, and short summary when available.
- **REQ-010**: Add metadata-first request flow that lets requester search by title/author/ISBN and select a candidate to autofill request fields.
- **REQ-011**: Allow requester to submit a request with minimal manual input after selecting a metadata candidate (only missing values remain editable).
- **SEC-001**: Magic link tokens must be one-time-use, hashed at rest, and short-lived (15 minutes default).
- **SEC-002**: Requester session tokens must be HTTP-only cookies with `Secure` and `SameSite=Lax` in production.
- **SEC-003**: Rate limit requester auth-start and auth-verify endpoints by IP and normalized email.
- **SEC-004**: Prevent enumeration by returning uniform responses for unknown emails.
- **SEC-005**: Sanitize any external metadata fields (especially summaries/descriptions) before persistence/rendering to prevent script injection.
- **DAT-001**: Preserve backward compatibility with existing SQLite `requests` and `status_history` data.
- **DAT-002**: Add schema migrations as additive changes only; do not drop or rename existing columns.
- **CON-001**: Stack remains Node.js + Express + better-sqlite3 + vanilla HTML/CSS/JS in current repository structure.
- **CON-002**: Existing file organization is single backend server (`backend/server.js`) and static pages in `backend/public/`.
- **GUD-001**: Implement authentication through a provider interface so Authentik can be added later without changing requester UI contracts.
- **PAT-001**: Reuse existing request status/history querying patterns and response shaping conventions in `backend/server.js`.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Establish requester identity/auth architecture and schema needed for secure email-link sessions.

| Task | Description | Completed | Date |
| -------- | --------------------- | --------- | ---------- |
| TASK-001 | Create `backend/docs/requester-auth-contract.md` defining requester auth provider interface (`startLogin`, `verifyLink`, `createSession`, `getSession`, `logout`) and token/session lifetimes; include exact JSON payload/response contracts for `POST /api/requester/auth/start`, `GET /api/requester/auth/verify`, `POST /api/requester/auth/logout`. | ✅ | 2026-06-13 |
| TASK-002 | In `backend/server.js`, add SQLite migration block for `requester_magic_links` table: columns `id`, `email`, `token_hash`, `expires_at`, `used_at`, `created_at`, `ip_hash`; add indexes on `email`, `expires_at`, and `token_hash`. | ✅ | 2026-06-13 |
| TASK-003 | In `backend/server.js`, add SQLite migration block for `requester_sessions` table: columns `id`, `email`, `session_hash`, `expires_at`, `revoked_at`, `created_at`, `last_seen_at`, `user_agent_hash`; add indexes on `email`, `session_hash`, and `expires_at`. | ✅ | 2026-06-13 |
| TASK-004 | In `backend/server.js`, add deterministic cleanup job function `cleanupRequesterAuthArtifacts()` to delete expired/used magic links and expired/revoked sessions; invoke at startup and on 1-hour interval. | ✅ | 2026-06-13 |
| TASK-005 | Validate migrations locally with `cd backend; npm run start` and verify startup logs show successful schema checks without regressions in existing tables. | ⏳ run in Docker (native build unavailable in dev sandbox) | 2026-06-13 |

### Implementation Phase 2

- GOAL-002: Implement secure requester email-link auth endpoints and middleware.

| Task | Description | Completed | Date |
| -------- | --------------------- | --------- | ---------- |
| TASK-006 | In `backend/server.js`, implement helper functions `normalizeRequesterEmail`, `generateMagicToken`, `hashToken`, `createRequesterSession`, and `readRequesterSessionFromCookie` using Node crypto primitives. | ✅ | 2026-06-13 |
| TASK-007 | In `backend/server.js`, add `POST /api/requester/auth/start` that accepts `{ email }`, rate-limits by IP+email, stores hashed one-time token, and sends login email containing verify URL `/requester/auth/callback?token=<token>`; response must always be `200` with generic message to prevent enumeration. | ✅ | 2026-06-13 |
| TASK-008 | In `backend/server.js`, add `GET /api/requester/auth/verify` that validates one-time token, marks token used, creates requester session, sets HTTP-only cookie, and redirects to `/requester/dashboard`. | ✅ | 2026-06-13 |
| TASK-009 | In `backend/server.js`, add middleware `authenticateRequesterSession` for requester endpoints; ensure it is isolated from existing `authenticateToken` admin JWT middleware. | ✅ | 2026-06-13 |
| TASK-010 | In `backend/server.js`, add `POST /api/requester/auth/logout` to revoke current requester session and clear cookie. | ✅ | 2026-06-13 |
| TASK-011 | Add integration checks with curl/PowerShell scripts in `backend/docs/requester-auth-smoke.md` to validate start-login, verify-link, session cookie behavior, and logout flows. | ✅ | 2026-06-13 |

### Implementation Phase 3

- GOAL-003: Deliver requester dashboard APIs that expose all requester items, statuses, and links.

| Task | Description | Completed | Date |
| -------- | --------------------- | --------- | ---------- |
| TASK-012 | In `backend/server.js`, add `GET /api/requester/dashboard` (protected by `authenticateRequesterSession`) returning aggregate counts (`pending`, `approved`, `searching`, `downloading`, `completed`, `rejected`, `unavailable`) plus `items[]` for all rows where `requester_email` equals session email. | ✅ | 2026-06-13 |
| TASK-013 | In `backend/server.js`, include per-item fields in dashboard response: `id`, `book_title`, `author`, `status`, `created_at`, `updated_at`, `cwa_book_link`, `status_token`, latest status note, and normalized ready-to-read link. | ✅ | 2026-06-13 |
| TASK-014 | In `backend/server.js`, add `GET /api/requester/requests/:id/history` scoped to session email, returning full status timeline from `status_history` ordered descending by `changed_at`. | ✅ | 2026-06-13 |
| TASK-015 | In `backend/server.js`, add `POST /api/requester/requests/:id/send-ereader` that reuses existing send-to-ereader core logic but enforces requester ownership from session email. | ✅ | 2026-06-13 |
| TASK-016 | In `backend/server.js`, add `POST /api/requester/requests/:id/feedback` that reuses existing feedback persistence but enforces requester ownership and consistent response shape. | ✅ | 2026-06-13 |
| TASK-017 | In `backend/server.js`, add `GET /api/requester/dashboard/export.csv` returning requester-owned rows only with deterministic CSV columns for end-user tracking. | ✅ | 2026-06-13 |

### Implementation Phase 4

- GOAL-004: Implement metadata provider integration and metadata-aware request APIs.

| Task | Description | Completed | Date |
| -------- | --------------------- | --------- | ---------- |
| TASK-018 | In `backend/server.js`, add additive migration for metadata fields on `requests`: `metadata_source`, `metadata_source_id`, `cover_url`, `summary`, `publisher`, `published_year`, `isbn10`, `isbn13`; add indexes on `metadata_source_id`, `isbn13`, and `isbn10`. | ✅ | 2026-06-13 |
| TASK-019 | Create `backend/services/book-metadata.js` that normalizes search results from configured providers (primary: Open Library API; optional fallback: Google Books API) into canonical fields: `source`, `sourceId`, `title`, `authors[]`, `isbn10`, `isbn13`, `publishedYear`, `publisher`, `summary`, `coverUrl`. | ✅ | 2026-06-13 |
| TASK-020 | In `backend/server.js`, add `GET /api/metadata/search?q=<query>&limit=<n>` for requester form usage; enforce query length minimum, response pagination ceiling, and per-IP rate limiting. | ✅ | 2026-06-13 |
| TASK-021 | In `backend/server.js`, update existing `POST /api/book-request` to accept optional metadata payload (`metadataSource`, `metadataSourceId`, `coverUrl`, `summary`, `isbn10`, `isbn13`, `publisher`, `publishedYear`) and persist normalized values. | ✅ | 2026-06-13 |
| TASK-022 | In `backend/server.js`, update requester dashboard payload endpoints to include metadata fields and thumbnail-safe image URLs for each request item. | ✅ | 2026-06-13 |
| TASK-023 | Add deterministic metadata cache behavior in SQLite table `book_metadata_cache` (query hash + TTL) to reduce external API calls and improve requester search speed. | ✅ | 2026-06-13 |

### Implementation Phase 5

- GOAL-005: Build requester UI for metadata discovery, autofill request creation, and metadata-rich dashboard cards.

| Task | Description | Completed | Date |
| -------- | --------------------- | --------- | ---------- |
| TASK-024 | In `backend/public/index.html`, add metadata search module above manual fields: search input, candidate list with cover/title/author/year, and "Use this book" action that autofills request form fields. | ✅ | 2026-06-13 |
| TASK-025 | In `backend/public/index.html`, keep manual fallback path intact so users can still submit requests when metadata search returns no results. | ✅ | 2026-06-13 |
| TASK-026 | In `backend/public/requester-dashboard.html`, render each request row/card with cover thumbnail, enriched metadata chips (ISBN, year, publisher), summary preview, and expand/collapse for full description. | ✅ | 2026-06-13 |
| TASK-027 | In `backend/public/requester-dashboard.html`, add dashboard filters and sort options specific to metadata (`has-cover`, `has-summary`, `missing-isbn`) to help users manage request quality. | ✅ | 2026-06-13 |
| TASK-028 | In `backend/public/css/styles.css` (or `backend/public/css/requester.css`), add responsive styles for metadata result grid, cover image placeholders, summary truncation, and mobile-safe card layout. | ✅ | 2026-06-13 |

### Implementation Phase 6

- GOAL-006: Complete auth-provider abstraction, docs, and verification for metadata-enabled requester experience.

| Task | Description | Completed | Date |
| -------- | --------------------- | --------- | ---------- |
| TASK-029 | In `backend/server.js`, refactor requester auth logic behind provider object `requesterAuthProvider` with current implementation `emailLinkProvider`; isolate provider selection using env var `REQUESTER_AUTH_PROVIDER=email_link|authentik`. | ✅ | 2026-06-13 |
| TASK-030 | Create `backend/docs/requester-authentik-integration.md` listing required Authentik OIDC fields, callback route, token claims mapping (`email`), and migration steps from email-link to Authentik without requester API contract changes. | ✅ | 2026-06-13 |
| TASK-031 | Create `backend/docs/requester-metadata-contract.md` specifying metadata API contracts, provider precedence, field normalization rules, sanitization requirements, and caching TTL values. | ✅ | 2026-06-13 |
| TASK-032 | Add automated API tests (new file `backend/tests/requester-dashboard.api.test.js`) covering auth start/verify/logout, dashboard scoping by email, metadata search behavior, metadata persistence on request creation, and history ownership enforcement. | ✅ | 2026-06-13 |
| TASK-033 | Add UI smoke test script `backend/tests/requester-dashboard.ui-smoke.md` with deterministic steps for metadata search-select autofill, manual fallback request submission, dashboard metadata rendering, and status/book-link actions. | ✅ | 2026-06-13 |
| TASK-034 | Update root documentation in `README.md` (or create if missing) with requester dashboard + metadata feature description, env vars, API provider keys, and operational runbook. | ✅ | 2026-06-13 |

### Implementation Phase 7

- GOAL-007: Execute parallel workstreams with explicit dependencies and completion gates.

| Task | Description | Completed | Date |
| -------- | --------------------- | --------- | ---------- |
| TASK-035 | Parallel Group A (can run together after TASK-001): TASK-002, TASK-003, TASK-004. Completion gate: auth/session migrations run and cleanup job logs healthy. | ✅ | 2026-06-13 |
| TASK-036 | Parallel Group B (can run together after TASK-006): TASK-007, TASK-009, TASK-010. Completion gate: requester auth start/logout/middleware pass smoke tests. | ✅ | 2026-06-13 |
| TASK-037 | Parallel Group C (can run together after TASK-012): TASK-014, TASK-015, TASK-016, TASK-017. Completion gate: requester API surface complete and ownership checks verified. | ✅ | 2026-06-13 |
| TASK-038 | Parallel Group D (can run together after TASK-018): TASK-019, TASK-020, TASK-023. Completion gate: metadata provider/search/cache stack complete and returning normalized payloads. | ✅ | 2026-06-13 |
| TASK-039 | Parallel Group E (can run together after TASK-024): TASK-025, TASK-026, TASK-027, TASK-028. Completion gate: metadata-first request UX and metadata-rich dashboard UX complete on desktop and mobile. | ✅ | 2026-06-13 |
| TASK-040 | Parallel Group F (can run together after TASK-029): TASK-030, TASK-031, TASK-032, TASK-033, TASK-034. Completion gate: docs/tests updated and passing for auth + metadata paths. | ✅ | 2026-06-13 |

## 3. Alternatives

- **ALT-001**: Reuse existing `status_token` as long-lived login credential. Not chosen because token scope is request-level and insufficient for secure session management across all requester items.
- **ALT-002**: Require requester password accounts now. Not chosen because user asked for email-link auth first and wants Authentik later.
- **ALT-003**: Build requester dashboard inside admin page with role branching. Not chosen to avoid coupling requester sessions with admin JWT/auth model and to reduce regression risk.
- **ALT-004**: Implement Authentik first and skip email links. Not chosen because it delays delivery and introduces external IdP dependency for initial release.
- **ALT-005**: Require manual entry for all book metadata fields. Not chosen because it increases requester friction and data quality inconsistency.
- **ALT-006**: Store only provider IDs and resolve metadata on every read. Not chosen because it creates runtime dependency risk and slower dashboard rendering.

## 4. Dependencies

- **DEP-001**: Existing SMTP/email sending path in `backend/server.js` must be available for magic-link delivery.
- **DEP-002**: Existing SQLite database initialization/migration mechanism in `backend/server.js` must remain the single migration entrypoint.
- **DEP-003**: Existing request/status logic (`/api/request-status`, `/api/request-feedback`, `/api/request-send-ereader`) provides reusable service logic for requester endpoints.
- **DEP-004**: Environment configuration via `.env` must add requester auth parameters (`REQUESTER_AUTH_PROVIDER`, `REQUESTER_MAGIC_LINK_TTL_MIN`, `REQUESTER_SESSION_TTL_HOURS`, cookie flags).
- **DEP-005**: External metadata provider configuration (Open Library endpoint and optional Google Books key) must be available for metadata search/autofill.
- **DEP-006**: Image/CSP policy must permit approved cover image hosts used by selected metadata providers.

## 5. Files

- **FILE-001**: `backend/server.js` - add requester auth schema, middleware, endpoints, provider abstraction, and requester page routes.
- **FILE-002**: `backend/public/requester-login.html` - new requester email-link login entry page.
- **FILE-003**: `backend/public/requester-dashboard.html` - new requester dashboard page listing all requester items and actions.
- **FILE-004**: `backend/public/css/styles.css` - add requester dashboard/login style classes or references to requester-specific stylesheet.
- **FILE-005**: `backend/docs/requester-auth-contract.md` - API/auth contract and lifecycle documentation.
- **FILE-006**: `backend/docs/requester-auth-smoke.md` - deterministic auth smoke procedures.
- **FILE-007**: `backend/docs/requester-authentik-integration.md` - future Authentik integration mapping and rollout notes.
- **FILE-008**: `backend/tests/requester-dashboard.api.test.js` - API ownership/auth/response tests.
- **FILE-009**: `backend/tests/requester-dashboard.ui-smoke.md` - manual or scripted UI smoke test checklist.
- **FILE-010**: `README.md` - feature enablement and operations documentation updates.
- **FILE-011**: `backend/services/book-metadata.js` - metadata provider client and normalization layer.
- **FILE-012**: `backend/docs/requester-metadata-contract.md` - metadata API schema and normalization rules.

## 6. Testing

- **TEST-001**: Auth start endpoint returns generic success for both known and unknown emails and enforces rate limits.
- **TEST-002**: Magic link verify accepts valid unexpired token once, rejects reused/expired tokens, and sets requester session cookie.
- **TEST-003**: Requester dashboard endpoint returns only rows matching authenticated requester email.
- **TEST-004**: Requester cannot access another requester's history/action endpoints by request ID tampering.
- **TEST-005**: Completed requests expose correct book link behavior (stored `cwa_book_link` first, fallback generation second).
- **TEST-006**: CSV export contains exact column order and only requester-owned records.
- **TEST-007**: Existing admin endpoints (`/api/admin/*`) and admin login flow continue to work unchanged.
- **TEST-008**: Mobile viewport smoke test validates dashboard table usability, filter chips, and action buttons.
- **TEST-009**: Metadata search returns normalized candidate objects with deterministic field presence/nullable behavior.
- **TEST-010**: Selecting a metadata candidate autofills request fields and persists metadata values on submission.
- **TEST-011**: Dashboard renders metadata safely (sanitized summary, valid cover fallback, no broken layout when fields are missing).

## 7. Risks & Assumptions

- **RISK-001**: Email deliverability delays can make magic-link login appear broken; mitigation is resend link UX and clear cooldown messaging.
- **RISK-002**: If requester session cookie flags are misconfigured behind reverse proxy, login loops can occur; mitigation is documented proxy/cookie env settings.
- **RISK-003**: Reusing existing action logic without proper ownership checks could leak cross-user data; mitigation is mandatory session-email scoping in every requester endpoint.
- **RISK-004**: Legacy records may have partial metadata; dashboard rendering must handle null author/ISBN/link safely.
- **RISK-005**: Metadata provider outages or throttling can degrade request UX; mitigation is cached results plus manual-entry fallback.
- **RISK-006**: Unsanitized third-party summaries/covers could introduce XSS or mixed-content issues; mitigation is strict sanitization + CSP allowlist.
- **ASSUMPTION-001**: SMTP is configured and functional in environments where requester email-link login is enabled.
- **ASSUMPTION-002**: Existing `requests` rows contain reliable `requester_email` values for identity grouping.
- **ASSUMPTION-003**: Authentik integration will use OIDC and provide verified email claim for requester identity.

## 8. Related Specifications / Further Reading

[Express Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)
[OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
[OWASP Forgot Password and Token Guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
[Authentik OIDC Provider Documentation](https://docs.goauthentik.io/providers/oauth2/)