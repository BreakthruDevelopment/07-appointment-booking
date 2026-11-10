import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** Half-open `tstzrange`. Drizzle has no range column; exclusion constraints are added in a custom migration. */
export const tstzrange = customType<{ data: string }>({
  dataType() {
    return "tstzrange";
  },
});

export type WallInterval = { start: number; end: number };

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Appointment booking. A provider is a profile on a user, not a third role.
// Rows are private to that user (an admin included): data functions filter on
// the owner and answer 404 when the row isn't theirs.
// ---------------------------------------------------------------------------

export const providerProfile = pgTable(
  "provider_profile",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(),
    displayName: text("display_name").notNull(),
    bio: text("bio").notNull().default(""),
    timeZone: text("time_zone").notNull(),
    accepting: boolean("accepting").notNull().default(false),
    minNoticeMinutes: integer("min_notice_minutes").notNull().default(0),
    horizonDays: integer("horizon_days").notNull().default(14),
  },
  (t) => [
    check("provider_slug_chk", sql`${t.slug} ~ '^[a-z0-9-]{3,40}$'`),
    check("provider_name_len", sql`char_length(${t.displayName}) between 1 and 80`),
    check("provider_bio_len", sql`char_length(${t.bio}) <= 500`),
    check("provider_notice_chk", sql`${t.minNoticeMinutes} between 0 and 10080`),
    check("provider_horizon_chk", sql`${t.horizonDays} between 1 and 60`),
  ],
);

export const service = pgTable(
  "service",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providerProfile.userId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    durationMin: integer("duration_min").notNull(),
    bufferBeforeMin: integer("buffer_before_min").notNull().default(0),
    bufferAfterMin: integer("buffer_after_min").notNull().default(0),
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    unique("service_id_provider_uq").on(t.id, t.providerId),
    index("service_provider_id_idx").on(t.providerId),
    check("service_name_len", sql`char_length(${t.name}) between 1 and 80`),
    check("service_desc_len", sql`char_length(${t.description}) <= 500`),
    check("service_duration_chk", sql`${t.durationMin} between 15 and 240 and ${t.durationMin} % 5 = 0`),
    check("service_buffer_chk", sql`${t.bufferBeforeMin} between 0 and 60 and ${t.bufferAfterMin} between 0 and 60`),
  ],
);

export const weeklyHours = pgTable(
  "weekly_hours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providerProfile.userId, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    startMin: integer("start_min").notNull(),
    endMin: integer("end_min").notNull(),
  },
  (t) => [
    index("weekly_hours_provider_id_idx").on(t.providerId),
    check("weekly_hours_weekday_chk", sql`${t.weekday} between 1 and 7`),
    check(
      "weekly_hours_span_chk",
      sql`${t.startMin} >= 0 and ${t.endMin} <= 1440 and ${t.startMin} < ${t.endMin} and ${t.startMin} % 15 = 0 and ${t.endMin} % 15 = 0`,
    ),
  ],
);

export const dateOverride = pgTable(
  "date_override",
  {
    providerId: text("provider_id")
      .notNull()
      .references(() => providerProfile.userId, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    closed: boolean("closed").notNull().default(false),
    intervals: jsonb("intervals").$type<WallInterval[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    primaryKey({ columns: [t.providerId, t.date] }),
    check(
      "date_override_intervals_chk",
      sql`jsonb_typeof(${t.intervals}) = 'array' and jsonb_array_length(${t.intervals}) <= 3`,
    ),
  ],
);

export const BOOKING_STATUSES = ["confirmed", "cancelled"] as const;
export const CANCELLED_BY = ["customer", "provider"] as const;

export const booking = pgTable(
  "booking",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true, precision: 3 }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true, precision: 3 }).notNull(),
    slot: tstzrange("slot").notNull(),
    blocked: tstzrange("blocked").notNull(),
    status: text("status", { enum: BOOKING_STATUSES }).notNull().default("confirmed"),
    cancelledBy: text("cancelled_by", { enum: CANCELLED_BY }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, precision: 3 }),
    customerNote: text("customer_note"),
    serviceName: text("service_name").notNull(),
    durationMin: integer("duration_min").notNull(),
    providerTz: text("provider_tz").notNull(),
    sequence: integer("sequence").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("booking_provider_starts_idx").on(t.providerId, t.startsAt),
    index("booking_customer_starts_idx").on(t.customerId, t.startsAt),
    foreignKey({
      columns: [t.serviceId, t.providerId],
      foreignColumns: [service.id, service.providerId],
      name: "booking_service_provider_fk",
    }),
    check("booking_parties_differ", sql`${t.providerId} <> ${t.customerId}`),
    check("booking_status_chk", sql`${t.status} in ('confirmed', 'cancelled')`),
    check(
      "booking_cancel_chk",
      sql`(${t.status} = 'confirmed' and ${t.cancelledBy} is null and ${t.cancelledAt} is null) or (${t.status} = 'cancelled' and ${t.cancelledBy} in ('customer', 'provider') and ${t.cancelledAt} is not null)`,
    ),
    check("booking_time_chk", sql`${t.endsAt} > ${t.startsAt}`),
    check("booking_blocked_contains_slot", sql`${t.blocked} @> ${t.slot}`),
    check("booking_slot_half_open", sql`lower_inc(${t.slot}) and not upper_inc(${t.slot})`),
    check("booking_blocked_half_open", sql`lower_inc(${t.blocked}) and not upper_inc(${t.blocked})`),
    check("booking_slot_bounds", sql`lower(${t.slot}) = ${t.startsAt} and upper(${t.slot}) = ${t.endsAt}`),
    check("booking_sequence_chk", sql`${t.sequence} >= 0`),
    check("booking_note_len", sql`${t.customerNote} is null or char_length(${t.customerNote}) <= 300`),
    check("booking_service_name_len", sql`char_length(${t.serviceName}) between 1 and 80`),
    check("booking_duration_chk", sql`${t.durationMin} between 15 and 240`),
  ],
);

export const calendarFeed = pgTable(
  "calendar_feed",
  {
    providerId: text("provider_id")
      .primaryKey()
      .references(() => providerProfile.userId, { onDelete: "cascade" }),
    tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [check("calendar_feed_hash_chk", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`)],
);

export const chatThread = pgTable(
  "chat_thread",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: text("customer_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => providerProfile.userId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique("chat_thread_id_customer_uq").on(t.id, t.customerId),
    unique("chat_thread_customer_provider_uq").on(t.customerId, t.providerId),
  ],
);

export const CHAT_ROLES = ["user", "assistant", "tool"] as const;

export const chatMessage = pgTable(
  "chat_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull(),
    customerId: text("customer_id").notNull(),
    role: text("role", { enum: CHAT_ROLES }).notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_message_thread_id_idx").on(t.threadId, t.createdAt),
    foreignKey({
      columns: [t.threadId, t.customerId],
      foreignColumns: [chatThread.id, chatThread.customerId],
      name: "chat_message_thread_customer_fk",
    }).onDelete("cascade"),
    check("chat_message_role_chk", sql`${t.role} in ('user', 'assistant', 'tool')`),
    check("chat_message_content_len", sql`octet_length(${t.content}::text) <= 4096`),
  ],
);

export const PROPOSAL_KINDS = ["book", "cancel"] as const;

export const bookingProposal = pgTable(
  "booking_proposal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull(),
    customerId: text("customer_id").notNull(),
    kind: text("kind", { enum: PROPOSAL_KINDS }).notNull(),
    serviceId: uuid("service_id").references(() => service.id, { onDelete: "set null" }),
    startsAt: timestamp("starts_at", { withTimezone: true, precision: 3 }),
    bookingId: uuid("booking_id").references(() => booking.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3 }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    foreignKey({
      columns: [t.threadId, t.customerId],
      foreignColumns: [chatThread.id, chatThread.customerId],
      name: "booking_proposal_thread_fk",
    }).onDelete("cascade"),
    check("booking_proposal_kind_chk", sql`${t.kind} in ('book', 'cancel')`),
  ],
);

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Kinds are this app's; changing a list needs
// a migration, because the CHECK constraints below are part of the schema.
// rate_event: per-user sliding windows. daily_usage: app-wide UTC-day caps.
// ---------------------------------------------------------------------------

export const RATE_KINDS = ["book", "chat", "feed_rotate"] as const;
export const DAILY_USAGE_KINDS = ["chat_step", "demo_load"] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** App-wide daily counters (one row per UTC day and kind) for free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

export type User = typeof user.$inferSelect;
export type ProviderProfile = typeof providerProfile.$inferSelect;
export type Service = typeof service.$inferSelect;
export type WeeklyHours = typeof weeklyHours.$inferSelect;
export type DateOverride = typeof dateOverride.$inferSelect;
export type Booking = typeof booking.$inferSelect;
