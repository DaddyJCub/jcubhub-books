# Requester Dashboard — UI Smoke Test

Deterministic manual checks. Start the server with `REQUESTER_AUTH_EXPOSE_TOKEN=true`
(non-production) so the login page surfaces a clickable dev sign-in link.

```bash
cd backend && REQUESTER_AUTH_EXPOSE_TOKEN=true npm run start
```

## A. Metadata search → autofill (REQ-010/011)

1. Open `http://localhost:3003/` → click **Request a Book**.
2. In **🔎 Find your book**, type `the hobbit tolkien`, press **Search**.
3. **Expect:** a result list with cover thumbnails, title, author, year/ISBN.
4. Click **Use this book** on a result.
5. **Expect:** Book Title, Author, and ISBN fields autofill; a green "✓ Using …" note appears.
6. Edit the Author field by hand.
7. **Expect:** the selection is cleared internally (manual values are what get submitted).

## B. Manual fallback (REQ-004 / TASK-025)

1. Search for gibberish (e.g. `zzzqqq___`).
2. **Expect:** "No matches found. You can still fill in the details manually below."
3. Fill Name, Email, Title, Author, Format manually, complete captcha, submit.
4. **Expect:** request submits successfully (existing flow unaffected).

## C. Sign in

1. Go to `http://localhost:3003/requester/login`.
2. Enter the same email used in B, click **Send sign-in link**.
3. **Expect:** generic success message + a dev sign-in link (test mode only).
4. Click the dev link.
5. **Expect:** redirect to `/requester/dashboard`, header shows "Signed in as <email>".

## D. Dashboard rendering (REQ-009 / TASK-026)

1. **Expect:** count chips for pending/approved/searching/downloading/completed/rejected/unavailable.
2. **Expect:** each request renders as a card: cover thumbnail (or 📖 placeholder),
   title, author, status badge, metadata chips (year/publisher/ISBN/format),
   and a summary preview with **Show more / Show less** when a summary exists.
3. Cards with no metadata still render cleanly (no broken layout — RISK-004/TEST-011).

## E. Filters, search, sort (REQ-006 / TASK-027)

1. Type in the search box → list filters by title/author/ISBN live.
2. Toggle a status chip (e.g. **pending**) → only matching cards show.
3. Toggle metadata chips **Has cover / Has summary / Missing ISBN** → list narrows accordingly.
4. Change **Sort** to "Title A–Z" / "Newest request" → order updates.

## F. Actions (REQ-007)

1. Click **View history** on a card → status timeline expands (newest first); click again to collapse.
2. For an available/completed item, **📚 Read / Download** links to the CWA book link.
3. **Send to eReader** (if enabled) → enter an allowed-domain email → success note.
4. For a searching/downloading item, **Match feedback** → "Looks correct" / "Wrong match" → confirmation.

## G. Account actions

1. **Export CSV** downloads `my-book-requests.csv` containing only your rows.
2. **Resend Login Link** → info banner confirms a fresh link was sent to your email.
3. **Log Out** → redirected to `/requester/login`; revisiting `/requester/dashboard`
   redirects back to login (session revoked).

## H. Mobile viewport (TEST-008)

1. Resize to ~375px width (or device emulation).
2. **Expect:** header stacks, cards use the compact cover size, metadata search result
   buttons span full width, filter chips wrap, all actions remain tappable.
