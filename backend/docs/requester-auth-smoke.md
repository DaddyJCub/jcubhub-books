# Requester Auth — Smoke Procedures

Deterministic manual checks for the email-link auth flow. Run the server with
`REQUESTER_AUTH_EXPOSE_TOKEN=true` and `NODE_ENV` unset (non-production) so the
`devToken` is returned in the start response.

```bash
cd backend
REQUESTER_AUTH_EXPOSE_TOKEN=true PORT=3003 npm run start
```

> All examples assume `BASE=http://localhost:3003`.

## 1. Start login (anti-enumeration)

PowerShell:
```powershell
$BASE = "http://localhost:3003"
$r = Invoke-RestMethod -Method Post -Uri "$BASE/api/requester/auth/start" `
  -ContentType "application/json" -Body (@{ email = "reader@example.com" } | ConvertTo-Json)
$r            # success:true, generic message
$token = $r.devToken   # present only in test mode
```

curl:
```bash
curl -s -X POST "$BASE/api/requester/auth/start" \
  -H 'Content-Type: application/json' \
  -d '{"email":"reader@example.com"}'
```
**Expect:** `200` with the generic message for *any* email (known or unknown).

## 2. Verify link + capture session cookie

```bash
# -i to see the Set-Cookie header and the 302 redirect to /requester/dashboard
curl -i -c cookies.txt "$BASE/api/requester/auth/verify?token=$TOKEN"
```
**Expect:** `302` → `Location: /requester/dashboard` and a `Set-Cookie:
jcub_requester_session=...; HttpOnly; SameSite=Lax`.

Reusing the same token a second time:
```bash
curl -i "$BASE/api/requester/auth/verify?token=$TOKEN"
```
**Expect:** `302` → `/requester/login?error=used`.

## 3. Authenticated session works

```bash
curl -s -b cookies.txt "$BASE/api/requester/me"
curl -s -b cookies.txt "$BASE/api/requester/dashboard"
```
**Expect:** `me` returns the email; `dashboard` returns `counts` + `items[]` scoped to that email.

Without the cookie:
```bash
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/requester/dashboard"
```
**Expect:** `401`.

## 4. Logout revokes the session

```bash
curl -s -b cookies.txt -X POST "$BASE/api/requester/auth/logout"
curl -s -o /dev/null -w "%{http_code}\n" -b cookies.txt "$BASE/api/requester/dashboard"
```
**Expect:** logout `{ "success": true }`, then `401` on the next dashboard call.

## 5. Expiry

Set `REQUESTER_MAGIC_LINK_TTL_MIN=0` (or wait past TTL) and verify a token →
`302 → /requester/login?error=expired`.
