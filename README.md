# Appointment Booking

> Salons, clinics, tutors and consultants publish services and opening hours; customers book a real open time from a
> phone, by tapping a slot or by asking a chat assistant, and nothing gets double-booked.

**Live:** https://app7.breakthruventures.ai · **Runs on:** Google Cloud · Part of
[30 apps in 30 days](https://github.com/BreakthruDevelopment/ai-dev-os)

## What this app does

Small businesses ask for "a Calendly or Square Appointments for my business". They care that customers only see
times that are actually free, that two people can never take the same slot, and, lately, that customers can just
ask for a time in plain words. The assistant here suggests a time, but only the customer's tap books it.

- **Providers** (any signed-in user who turns on **Accept bookings**) set a page link, time zone, minimum notice,
  how far ahead people can book, services (length and buffers), weekly hours, and dates with different hours or
  closed. They see and cancel the bookings on their calendar and get a private calendar-feed link for their own
  calendar app.
- **Customers** (any signed-in user) open a provider's page at `/p/<link>`, pick a service, day and time, and
  confirm. They see and cancel their own bookings and download each one as an `.ics` file.
- **Customers** can choose **Ask the assistant** instead ("anything Tuesday after 3?"). The assistant only offers
  times the availability engine returns and shows a confirm card. Nothing is booked until the customer taps
  **Confirm booking**.
- **Admins** see counts only (providers, services, bookings by status, assistant turns and model steps against the
  daily cap), load the demo workspace and manage accounts. They can't see or change any booking, message or provider
  setup.

## Try it

Self-service needs two accounts, one as provider and one as customer. Use two browsers or a private window.

1. Open https://app7.breakthruventures.ai, choose **Get started** and create an account (any email, password of 10
   or more characters).
2. **Provider account:** open **Provider**, fill in the profile, tick **Accept bookings (publishes your page)**,
   then add a service and weekly hours. The page link appears on the Provider page.
3. **Customer account:** open that link, pick a time and choose **Confirm booking**, or choose **Ask the
   assistant**.

If an admin has loaded the demo workspace, `/p/demo-studio` is a ready-made salon ("Demo Studio", America/Denver,
Haircut, Color and style, Consultation; weekdays 9-12 and 13-18, Saturdays 10-14). Its provider and customers are
sample users with no password, so nobody can sign in as them.

## The AI feature

The booking assistant (`booking-assistant` task, `src/lib/assistant/`) runs on the shared gateway's tool loop,
`generate({ tools })` in `src/lib/ai`. The live app is deployed with `AI_PROVIDER=gemini` (default model
`gemini-flash-lite-latest`; `AI_MODEL` overrides it).

**Tools.** The provider and the signed-in customer are bound on the server inside each tool. The model never
supplies a user or provider id.

| Tool | What it does | Kind |
| --- | --- | --- |
| `find_open_slots` | Open times for one service over up to 7 days, from the same engine as the booking page. Returns at most 12, as `A1`, `A2`, ... | read |
| `propose_booking` | Re-checks the slot and writes a `booking_proposal` row that expires in 10 minutes | propose |
| `list_my_bookings` | This customer's upcoming bookings with this provider only, as `B1`, `B2`, ... | read |
| `propose_cancel` | Checks the customer owns the booking and can still cancel it, and writes a cancel proposal | propose |

**No tool books or cancels.** The confirm card is rendered from the proposal row, never from model text. Tapping it
goes through the same booking and cancel code as the page, which checks that the proposal belongs to this customer,
hasn't expired and hasn't been used, and that the slot is still free. Services, slots and bookings appear to the
model as opaque references (`S1`, `A1`, `B1`) mapped back on the server for this turn only.

**Guardrails.**

- Output is validated with zod: a reply of at most 600 characters, a proposal id, and up to 3 suggestions. The
  model's proposal id is ignored; the card always shows the latest proposal this turn's tools created.
- Input: the new message is capped at 500 characters. History is built on the server from stored messages (the last
  10, at most 5,000 characters), so a client can't forge earlier turns. Provider and service names are stripped of
  angle brackets and control characters. The system prompt is capped at 8,000 characters and says that messages,
  context and tool results are data, not instructions.
- Each turn is limited to 4 model steps, 6 tool calls and 24 seconds (Cloud Run's request timeout is 30 seconds). If
  the loop runs out, the customer gets "I couldn't finish that; here are the open times on the page." If a live model
  fails, the recorded demo script is not shown.
- Limits: 20 assistant turns per customer per hour. `CHAT_DAILY_CAP` (default 400) caps model steps app-wide per UTC
  day; each turn reserves its 4 steps before calling the model.
- Logs record task, steps, tool names, outcomes and latency, never message text.
- Demo mode (`AI_PROVIDER=demo`) runs a scripted turn through the real tools: it finds the first open time for the
  first service and proposes it, labelled as recorded.

Tests: `test/assistant.integration.test.ts` and `test/ai-evals.test.ts` (scripted tool calls, including a call to an
unknown `create_booking` tool and a cancel aimed at another customer's booking).

## Architecture

```
Browser (desktop and phone)
   │ HTTPS + session cookie
   ▼
Next.js container ── pages, server actions, route handlers (/api/*)
   │                  auth + RBAC, zod validation, AI gateway with tool loop, JSON logs, /api/health
   ├──► Postgres 17 (Drizzle; btree_gist exclusion constraints)
   └──► Model API (Gemini, or recorded demo answers)
Calendar apps ──► GET /api/calendar/<token> (private .ics feed)
```

- **Google Cloud Run** (1 vCPU, 512 MiB, at most 1 instance, CPU only while handling a request, 30-second
  timeout). Postgres runs on an always-free e2-micro VM on a private network. There is no background work; the
  assistant runs inside the request.
- **Availability engine** (`src/lib/availability.ts`, a pure function). Hours are wall-clock minutes in the
  provider's IANA time zone. Candidate starts every 15 minutes must fit inside working hours, respect minimum notice
  and the booking horizon, and keep the buffers clear of other confirmed bookings. At most 14 days per query and 200
  slots. The page shows times in the viewer's time zone and names it.
- **Daylight saving.** Start times that don't exist (spring forward) are skipped. In the repeated hour (fall back)
  the first occurrence is used, so the repeated hour isn't bookable. A slot's length is in absolute minutes, so a
  60-minute appointment across a change is still 60 minutes.
- **No double booking.** Two Postgres exclusion constraints (`drizzle/0003_booking-exclusions.sql`): confirmed
  bookings for one provider can't have overlapping blocked ranges (appointment plus buffers), and one customer can't
  hold two overlapping confirmed appointments anywhere. The booking transaction re-runs the availability check, and
  a constraint violation becomes 409 "That time was just taken." with fresh nearby times.
- **Calendar export.** `GET /api/bookings/<id>/ics` returns one RFC 5545 event (hand-written in `src/lib/ics.ts`).
  A cancel keeps the UID, raises `SEQUENCE` and sets `STATUS:CANCELLED`. The provider feed lists confirmed bookings
  from 30 days back to 60 days ahead plus those cancelled in the last 7 days, with the service and the customer's
  first name only. Calendar apps refresh feeds on their own schedule.
- `GET /api/health` reports database status and the deployed image tag, and returns 503 if the database is down.

## Data model

Defined in `src/lib/db/schema.ts`; migrations in `drizzle/`.

| Table | Holds |
| --- | --- |
| `provider_profile` | One per provider user: link (`slug`, 3-40 characters, reserved words refused), display name, bio, time zone, accepting flag, minimum notice, horizon |
| `service` | A provider's services: name, length, buffers before and after, active, order (at most 20) |
| `weekly_hours` | Opening intervals per ISO weekday in local minutes (at most 3 per day, 50 rows) |
| `date_override` | A date that is closed or has different hours (at most 60 future dates) |
| `booking` | `provider_id` and `customer_id`, start and end, `slot` and `blocked` ranges, status, who cancelled, note, snapshots of service name, length and provider time zone, `sequence` for `.ics` updates |
| `calendar_feed` | The provider's feed token, stored only as a SHA-256 hash |
| `chat_thread`, `chat_message` | One thread per customer and provider; the server-side history the assistant reads |
| `booking_proposal` | A book or cancel suggestion created by the assistant's tools, with expiry and used time |
| `rate_event`, `daily_usage` | Per-user hourly limits and app-wide daily caps |

## Security

**Roles.** Better Auth with two roles, `user` and `admin`. Provider is a profile on a `user` account, not a role:
ownership already separates the data (a provider owns their services, hours and the bookings on them; a customer
owns the bookings they made). A booking is visible only to its customer and its provider. `admin` has counts, the
demo loader and account management. `src/lib/auth/permissions.ts` withholds impersonation, set-password, set-email
and session listing from admins.

**Enforcement.**

- Every page calls `requireUserOrRedirect()` or `requireRoleOrRedirect()`, and every route handler and server action
  calls `requireUser()` or `requireRole()`, except the public provider page, provider details, slots and the feed.
- Booking queries filter on `customer_id = actor` or `provider_id = actor`. Anything else returns 404, for admins
  too. Provider setup is filtered by owner.
- The public provider endpoints never return the owner's id or email. A provider who isn't accepting bookings isn't
  public.
- Mutating routes check the Origin header against `APP_URL`, cap JSON bodies at 16 KB and validate with zod. Errors
  go through `errorResponse()`, with no stack traces.
- The feed token is 32 random bytes, shown once, stored as a SHA-256 hash and compared in constant time. Making a new
  link revokes the old one at once. An unknown token gets 404.
- Limits: 10 booking attempts per hour (failed ones count), 3 upcoming bookings per provider and 10 overall per
  customer, slot lookups at 60 per IP per minute (in memory), 5 feed rotations per hour, and the assistant limits
  above. Customers can cancel online until the start time minus the provider's minimum notice; providers can cancel
  any time before the start.

**Tests.** `test/bookings.integration.test.ts` covers server-side re-validation, 409 with fresh times, exactly one
winner among 10 concurrent customers over 20 rounds, the caps, both cancel rules, `.ics` output (parsed with
`ical.js`) and 404 for everyone outside the booking, admin included. `test/provider.integration.test.ts`,
`test/feed.integration.test.ts`, `test/admin-overview.integration.test.ts` and
`test/admin-permissions.integration.test.ts` cover setup ownership, the feed and admin limits. `scripts/smoke.sh`
repeats the booking, 409, 404, `.ics`, feed and cancel flow over HTTP.

## Known limits

- **No email or SMS.** The `.ics` file is the confirmation, and there are no reminders, password resets or
  verification emails.
- **Google Calendar sync isn't built.** The planned design uses the provider's Google free/busy and writes events.
  It needs an OAuth client. While the OAuth app stays in Google's "Testing" mode, refresh tokens expire after 7 days,
  so providers would have to reconnect weekly; leaving Testing for a sensitive Calendar scope needs Google's
  verification. Today providers subscribe to the feed instead, which is one-way and refreshes when their calendar
  app polls.
- No rescheduling (cancel and rebook), payments, deposits, recurring appointments, group classes, waitlists,
  multi-staff teams or guest booking without an account.
- The slot-lookup limit is in memory, which matches the single Cloud Run instance; it resets when the instance
  restarts.
- `/p/demo-studio` exists only after an admin loads the demo workspace.

## Free-tier budget

| Resource | Control |
| --- | --- |
| Cloud Run | 1 instance, CPU only during requests, 30-second timeout; an assistant turn stops at 24 seconds |
| Postgres on the e2-micro VM | Per provider: at most 20 services, 50 hour rows and 60 future overrides; bookings capped per customer |
| Gemini | At most 4 model steps per turn, 20 turns per user per hour, `CHAT_DAILY_CAP` model steps per day app-wide |
| Scheduler, queues, email | Not used |

## Configuration

Names only; values live in the cloud's secret store or `.env.local`. See `.env.example` and `src/lib/env.ts`.

| Variable | Purpose |
| --- | --- |
| `APP_URL`, `APP_NAME` | Public URL (also the only allowed Origin, and the host in `.ics` UIDs and feed links) and display name |
| `DATABASE_URL` | Postgres connection |
| `BETTER_AUTH_SECRET` | Session signing, at least 32 characters |
| `AI_PROVIDER`, `AI_MODEL`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Model choice (`demo`, `gemini` or `anthropic`) |
| `AI_FALLBACK_TO_DEMO`, `AI_TIMEOUT_MS` | Fallback to recorded answers, provider timeout (max 22 s) |
| `CHAT_DAILY_CAP` | App-wide assistant model steps per UTC day (default 400) |
| `MIGRATE_ON_START` | Apply migrations at startup (on in the cloud) |
| `LOG_LEVEL` | JSON log level |

## Run it locally

```bash
cp .env.example .env.local          # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db             # Postgres 17
pnpm install
pnpm db:migrate                     # includes CREATE EXTENSION btree_gist
pnpm dev                            # http://localhost:3000
```

`AI_PROVIDER=demo` (the default) needs no key or network. To make yourself an admin, sign up, then run
`SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm db:seed` while the app is running. Then use **Load demo
data** on **Admin** to create Demo Studio.

Checks:

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests
TEST_DATABASE_URL=postgres://... pnpm test # plus integration tests against real Postgres
pnpm build && pnpm smoke                   # HTTP smoke test against a running app (BASE_URL)
```

## Deploy it yourself

Every push to `main` publishes a multi-arch image to
`ghcr.io/breakthrudevelopment/07-appointment-booking:sha-<commit>`.
[30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra) deploys a pinned tag with Terraform. The
same image runs on AWS (Lambda), Azure (Container Apps), Google Cloud (Cloud Run) and Oracle Cloud (Docker on a VM);
see `infra/README.md`. This repo holds no cloud credentials. With `MIGRATE_ON_START=true`, the server applies
pending migrations before taking traffic. The database must allow `CREATE EXTENSION btree_gist`.

## 2-minute demo script

Use two browsers, one signed in as the provider (P) and one as the customer (C1), plus a private window for a
second customer (C2).

1. **P sets up.** On **Provider**, save a profile in your time zone, tick **Accept bookings**, add a 30-minute
   service and weekday hours that include Tuesday afternoon. *Proves: any user can become a provider without a new
   role.*
2. **C1 asks the assistant.** Open P's page, choose **Ask the assistant** and type "anything Tuesday after 3?". The
   reply offers a real time with a confirm card. *Proves: the assistant uses the same availability as the page.*
3. **C1 confirms.** Tap **Confirm booking**. The booking appears under **Bookings**, with an `.ics` download.
   *Proves: only the customer's tap books; the card shows the stored proposal, not model text.*
4. **C2 tries the same time.** On P's page, the slot is gone, and the assistant only offers other open times.
   A request that races past the page check gets 409 "That time was just taken." *Proves: database-enforced no double booking.*
5. **P checks the calendar.** On **Provider**, **Open your calendar** lists the booking. **Make my calendar link** gives a feed URL
   to subscribe to in Google, Apple or Outlook calendar; the event shows the service and C1's first name only.
   *Proves: calendar export without sharing customer emails.*
6. **Admin view** (admin account). **Admin** shows counts and the assistant's daily usage, and no booking details.
   *Proves: admins see counts only.*
