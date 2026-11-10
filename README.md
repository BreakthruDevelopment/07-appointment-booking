# Appointment Booking

> Publish services and weekly availability, let customers book open times from their phones without double-booking, and converse with an AI assistant that proposes verified slots for one-tap confirmation.

**Live:** https://app7.breakthruventures.ai · **Runs on:** Google Cloud (Cloud Run, us-central1) · Part of
[30 apps in 30 days](https://github.com/BreakthruDevelopment/ai-dev-os)

## What it does

Salons, clinics, tutors, and solo consultants need a clean, self-hosted Calendly / Square Appointments alternative:
publish services, define working hours, share booking links, and eliminate double-booking across time zones.

- **Public booking page (`/p/[slug]`):** Anyone can browse a provider's active services, select dates on a responsive day strip, view available times in their own local time zone, and sign in to confirm a slot.
- **Customer self-service (`/bookings`):** Customers view upcoming and past appointments, download standard `.ics` calendar invites, cancel appointments within notice windows, or chat with the provider's AI assistant.
- **Provider management (`/provider` & `/provider/calendar`):** Any user can toggle "Accept bookings" to configure their booking profile, public slug, IANA time zone, buffer times, minimum notice, booking horizon, weekly working hours, and single-day date overrides. Providers view their agenda by day, cancel appointments, and subscribe to their private calendar feed.
- **Admin oversight (`/admin`):** Admins monitor platform health and aggregate metric counts only (provider count, active services, bookings by status, chat turns, and model tool calls vs caps). Admins cannot view client notes or manage appointments for other users.
- **AI booking assistant (`/p/[slug]/chat`):** Customers converse with an AI assistant that queries live availability and generates structured booking proposals. Appointments are never finalized until the customer explicitly taps Confirm.

### Provider as profile, not a role

In this system, **provider is a profile, not a separate Better Auth role**. Any authenticated user can set up a provider profile and publish a booking page. Data ownership cleanly isolates responsibilities:
- A user owns their customer bookings.
- A provider profile owns their services, working hours, date overrides, and the bookings scheduled against them.
- A booking is strictly visible to exactly two parties: its customer and its provider.

Adding a third role would introduce redundant role checks without security benefit. Better Auth maintains two system roles: `user` and `admin` (where `admin` sees counts only).

## Availability engine and DST

Availability calculation is implemented as a deterministic pure function (`availableSlots` in `src/lib/availability.ts`). Given a provider profile, service configuration, weekly working hours, date overrides, confirmed busy ranges, query window (`from`/`to`), and the current instant `now`, it computes bookable slots:

1. **Time zones & wall-clock intervals:** Providers specify an IANA time zone (validated against `Intl.supportedValuesOf("timeZone")` and Postgres `pg_timezone_names`). Weekly working hours and date overrides are defined in local wall-clock minutes (0–1,440). Intervals are converted to exact UTC instants using `@date-fns/tz` (`TZDate`). The API communicates in UTC ISO strings; client interfaces render times converted to the viewer's local time zone while explicitly naming the provider's zone ("Times shown in your time zone, America/Denver").
2. **Daylight Saving Time (DST):**
   - **Spring-forward:** Local start times falling into skipped clock transitions are omitted.
   - **Fall-back:** Ambiguous local times during clock rollbacks consistently resolve to the first occurrence.
   - **Absolute duration:** Slots represent `[start, start + duration)` in elapsed absolute minutes; a 60-minute appointment spanning a DST change remains exactly 60 minutes long.
   - Handled and tested against critical boundaries (America/New_York, Europe/London, Australia/Lord_Howe 30-minute shifts, and Asia/Kolkata).
3. **Candidate generation & overrides:** Working hours generate candidate start intervals spaced at 15-minute steps (`slot_step`). Specific date overrides replace weekly hours or mark dates closed.
4. **Buffer times & busy ranges:** Services configure optional `buffer_before_min` and `buffer_after_min` (0–60 min). A candidate slot is rejected if `[start - buffer_before, end + buffer_after)` intersects the blocked range of any confirmed appointment.
5. **Notice & horizon limits:** Slots must satisfy `start >= now + min_notice_minutes` and `start < now + horizon_days`. Availability queries span at most 14 days and cap output at 200 slots.

## Concurrency and double-booking prevention

Double-booking prevention is enforced at the database layer rather than relying on brittle in-memory locks:

- **Postgres exclusion constraints:** The `booking` table maintains a PostgreSQL `tstzrange` column named `blocked` (`[starts_at - buffer_before, ends_at + buffer_after)`). A GiST exclusion constraint prevents any overlapping confirmed appointments:
  ```sql
  EXCLUDE USING gist (provider_id WITH =, blocked WITH &&) WHERE (status = 'confirmed')
  ```
  A second exclusion constraint on `(customer_id, slot)` ensures a single customer cannot hold concurrent appointments across any providers.
- **btree_gist extension:** Database migration enables `create extension if not exists btree_gist`.
- **In-transaction validation:** When `createBooking` executes, it re-verifies availability inside the database transaction (service active, provider accepting bookings, provider != customer, working hours, notice, horizon, and step alignment).
- **Graceful conflict handling:** Concurrency collisions trigger Postgres error `23P01` (exclusion violation), translated into HTTP `409 Conflict` ("That time was just taken") and returning fresh availability options.
- **Fair-use limits:** Max 3 future appointments per customer per provider (10 overall), and at most 10 booking attempts per hour per user.

## Calendar export and subscribe feed

- **Single booking `.ics` (`GET /api/bookings/[id]/ics`):** Customers and providers can download an RFC 5545 compliant `.ics` calendar event. Built with strict CRLF line endings, 75-octet line folding, proper character escaping (`\`, `;`, `,`, newlines), unique `UID:<id>@app7.breakthruventures.ai`, UTC `DTSTART`/`DTEND`, and incremented `SEQUENCE` with `STATUS:CANCELLED` on cancellation.
- **Provider subscribe feed (`GET /api/calendar/[token].ics`):** Providers can subscribe to their calendar feed in Apple Calendar, Google Calendar, or Outlook. The private URL includes a 32-byte cryptographically secure random token (base64url) stored as a SHA-256 hash in `calendar_feed`. Tokens can be rotated on demand. The feed serves confirmed appointments spanning 30 days prior through 60 days ahead (and cancellations from the past 7 days). To safeguard customer privacy, event summaries display the service title and the customer's **first name only** (no emails or phone numbers).
- **Polling expectations:** Calendar clients refresh feeds on external schedules (Google Calendar often caches feeds for several hours); the provider dashboard explicitly notes this behavior.

## Google Calendar two-way sync (later option & 7-day testing caveat)

Two-way Google Calendar synchronization is architecturally designed for future enablement:
- **Design:** Authenticates via Better Auth Google social link (`linkSocial`) requesting `access_type=offline` and scopes `calendar.events.owned` and `calendar.freebusy`. Refresh tokens are secured using envelope encryption (AES-256-GCM with AAD bound to the user id). The availability engine queries Google FreeBusy for the upcoming 14 days (cached 5 minutes), writes booked appointments to Google Calendar, and removes cancelled ones.
- **The 7-Day testing caveat:** In Google Cloud Console, OAuth consent screens remaining in "Testing" status issue refresh tokens that **expire after 7 days**. As a result, providers would be forced to reconnect their Google account weekly. Promoting the OAuth app to "Production" with sensitive calendar scopes requires Google's formal app verification process. For this reason, core appointment booking ships with private `.ics` subscription feeds, leaving direct Google Calendar OAuth sync as an optional future enhancement.

## The AI booking assistant

Customers can schedule or cancel appointments conversationally through a chat assistant on `/p/[slug]/chat`.

### The propose-and-confirm design invariant

To prevent hallucinated bookings or accidental commitments, the assistant operates under a strict security invariant: **the model has no write tools**.

- **Read & propose tools only:** The assistant only accesses four tools:
  - `find_open_slots`: Fetches verified available slots (`<= 12`) for a service over a given date range.
  - `propose_booking`: Writes a short-lived `booking_proposal` record (expires in 10 minutes) and returns proposal metadata.
  - `list_my_bookings`: Lists the signed-in customer's upcoming bookings with this provider.
  - `propose_cancel`: Validates appointment ownership and generates a cancellation proposal.
- **Human confirmation:** The model cannot create or cancel bookings directly. Instead, calling `propose_*` renders a structured **Confirm Card** in the chat UI based strictly on verified `booking_proposal` database records—never from raw assistant text. The appointment is finalized only when the user explicitly clicks the **Confirm** button, dispatching a standard `POST /api/bookings { proposalId }` request through the exact same transactional validation pipeline.
- **Closed tool handlers:** Tool executions bind `providerId` and `actor` directly in server closures, completely preventing model-directed parameter tampering. All IDs exposed to the model are ephemeral, opaque turn tokens (`S1..S20`, `A1..A12`, `B1..B10`).
- **Safety guardrails:** Enforces a maximum of 4 model steps per turn, at most 3 tool calls per step, a 24-second timeout per turn, tool result serialization capped at 2 KB, user input capped at 500 characters, and 20 turns per user per hour. Untrusted customer messages and tool outputs are treated strictly as data.

## Architecture

```
Browser (desktop and phone)
   │ HTTPS + session cookie
   ▼
Cloud Run container (Next.js App Router) ── pages, server actions, route handlers (/api/*)
   │                                        auth + RBAC, zod validation, AI gateway, JSON logs, /api/health
   ├──► Postgres 17 (Drizzle + btree_gist) on e2-micro VM
   └──► Gemini API (gemini-flash-latest, free tier, or recorded demo answers)
```

| Concern | Implementation |
| --- | --- |
| Runtime environment | Google Cloud Run, 1 vCPU / 512 MiB, `cpu_idle = true` (30 s timeout) |
| Database & constraints | PostgreSQL 17 on e2-micro VM, Drizzle ORM, `btree_gist` exclusion constraints |
| Authentication & roles | Better Auth with Admin plugin (`user`, `admin`); provider profile |
| Authorization & security | Server-side authorization in all data functions; tenant isolation |
| AI tool loop | Multi-step tool-use loop with `generate()`, Gemini free tier & demo fallback |
| Calendar export & feed | RFC 5545 `.ics` generator, SHA-256 hashed feed tokens |
| Health probe | `GET /api/health` (returns 503 if database check fails) |

## Security

- **Server-side authorization:** Every route handler and server action enforces session validation (`requireUser()` / `requireRole()`). Data operations call `assertCan()` and filter by owner.
- **Tenant isolation:** Appointments are queryable only by the customer (`customer_id = actor.id`) or the provider (`provider_id = actor.id`). All attempts to access foreign bookings return `404 Not Found` for both users and administrators.
- **Admin privacy:** Administrators view aggregate platform counters only (provider totals, service counts, booking status distributions, and AI chat usage vs quotas). Admins cannot inspect appointment notes or impersonate users.
- **Feed token protection:** Calendar feed tokens are 32-byte base64url random strings. Only their SHA-256 digests are stored in the database. Tokens are displayed once upon creation and can be rotated at any time.
- **Input sanitization & CSRF:** All payloads are validated using Zod schemas at boundary routes. Mutating endpoints enforce origin validation (`requireSameOrigin`) and reject bodies exceeding 16 KB.

## Free-tier budget

| Resource | Control / Invariant | Worst case per month |
| --- | --- | --- |
| **Cloud Run** (2M requests, 180k vCPU-s, 360k GiB-s free) | Max 1 instance, CPU idle between requests; chat turn bounded at <=24 s | Well within free tier |
| **e2-micro Postgres** (30 GB disk, 60 shared connections) | Caps: <=20 services, <=50 hour intervals, <=60 overrides per provider | Lightweight (megabytes) |
| **Gemini API** | Max 4 model steps per turn; 20 turns/user/hr; `CHAT_DAILY_CAP` 400 steps app-wide | Zero-cost free tier |

## Run locally

```bash
cp .env.example .env.local          # set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db
pnpm install
pnpm db:migrate
pnpm dev                            # http://localhost:3000
```

### Seeding demo data

To load the seed admin and the "Demo Studio" provider with services, weekly availability, and sample bookings across a daylight saving week:
```bash
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD=admin-password-123 pnpm db:seed
```

### Environment variables

Names only (never commit secrets):
| Variable | Purpose |
| --- | --- |
| `APP_NAME` | Application name for branding and headers |
| `APP_URL` | Base public URL (e.g. `https://app7.breakthruventures.ai`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | 32+ character random secret for session encryption |
| `AI_PROVIDER` | `gemini` (live), `anthropic`, or `demo` (recorded offline answers) |
| `GEMINI_API_KEY` | Google Gemini API key |
| `AI_FALLBACK_TO_DEMO` | Fallback to recorded demo answers on quota or network errors (`true`/`false`) |
| `LOG_LEVEL` | Logging level (`debug`, `info`, `warn`, `error`) |
| `MIGRATE_ON_START` | Auto-apply pending migrations on container start (`true`/`false`) |

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests and type checks
TEST_DATABASE_URL=postgres://... pnpm test # data-layer tests with PostgreSQL exclusion constraints
pnpm build && pnpm smoke                   # full build and end-to-end smoke test
```

## Deploy it yourself

Deployments run via Docker containers to Cloud Run with Terraform managed in [30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra). Multi-arch container images publish to GitHub Container Registry on pushes to `main`. When `MIGRATE_ON_START=true`, database migrations run during startup under a PostgreSQL advisory lock.

## 2-minute demo script

1. **Browse provider page (`/p/demo-studio`):**
   Open the public booking page for "Demo Studio". Point out the services (e.g., Haircut, Styling) and the 7-day slot picker showing open times in your local time zone ("Times shown in your time zone, America/Denver").
2. **Chat with the booking assistant (`/p/demo-studio/chat`):**
   Click **Ask the assistant**. Sign in as customer `customer-a@example.com`. Type: *"Can I get a haircut next Tuesday after 3pm?"*
   *Proves:* The assistant invokes `find_open_slots` and `propose_booking` to find a matching Tuesday slot without inventing times.
3. **Confirm the booking proposal:**
   Notice the assistant does not book directly, but presents a structured **Confirm Card** displaying the service, duration, and local time. Tap **Confirm**.
   *Proves:* Bookings require human consent. The UI redirects to `/bookings` displaying the confirmed appointment with an option to download the `.ics` calendar file.
4. **Demonstrate double-booking rejection (Concurrency & exclusion constraint):**
   Open an incognito window, navigate to `/p/demo-studio`, and sign in as customer `customer-b@example.com`. Attempt to book the exact same Tuesday slot.
   *Proves:* The database exclusion constraint blocks the insertion with Postgres error `23P01`. The server returns HTTP `409 Conflict` ("That time was just taken") and displays updated alternative slots.
5. **Verify provider agenda and private subscribe feed (`/provider/calendar`):**
   Sign in as provider `provider@example.com` and open the agenda view at `/provider/calendar`. The Tuesday appointment appears on the schedule. Copy the calendar subscribe feed link from `/provider` and import it into a calendar app (or fetch `/api/calendar/[token].ics`).
   *Proves:* The RFC 5545 calendar feed reflects the newly confirmed booking showing the service name and customer's first name only, preserving privacy.
