CREATE TABLE "booking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"service_id" uuid NOT NULL,
	"starts_at" timestamp (3) with time zone NOT NULL,
	"ends_at" timestamp (3) with time zone NOT NULL,
	"slot" "tstzrange" NOT NULL,
	"blocked" "tstzrange" NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"cancelled_by" text,
	"cancelled_at" timestamp (3) with time zone,
	"customer_note" text,
	"service_name" text NOT NULL,
	"duration_min" integer NOT NULL,
	"provider_tz" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_parties_differ" CHECK ("booking"."provider_id" <> "booking"."customer_id"),
	CONSTRAINT "booking_status_chk" CHECK ("booking"."status" in ('confirmed', 'cancelled')),
	CONSTRAINT "booking_cancel_chk" CHECK (("booking"."status" = 'confirmed' and "booking"."cancelled_by" is null and "booking"."cancelled_at" is null) or ("booking"."status" = 'cancelled' and "booking"."cancelled_by" in ('customer', 'provider') and "booking"."cancelled_at" is not null)),
	CONSTRAINT "booking_time_chk" CHECK ("booking"."ends_at" > "booking"."starts_at"),
	CONSTRAINT "booking_blocked_contains_slot" CHECK ("booking"."blocked" @> "booking"."slot"),
	CONSTRAINT "booking_slot_bounds" CHECK (lower("booking"."slot") = "booking"."starts_at" and upper("booking"."slot") = "booking"."ends_at"),
	CONSTRAINT "booking_sequence_chk" CHECK ("booking"."sequence" >= 0),
	CONSTRAINT "booking_note_len" CHECK ("booking"."customer_note" is null or char_length("booking"."customer_note") <= 300),
	CONSTRAINT "booking_service_name_len" CHECK (char_length("booking"."service_name") between 1 and 80),
	CONSTRAINT "booking_duration_chk" CHECK ("booking"."duration_min" between 15 and 240)
);
--> statement-breakpoint
CREATE TABLE "booking_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"kind" text NOT NULL,
	"service_id" uuid,
	"starts_at" timestamp (3) with time zone,
	"booking_id" uuid,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	CONSTRAINT "booking_proposal_kind_chk" CHECK ("booking_proposal"."kind" in ('book', 'cancel'))
);
--> statement-breakpoint
CREATE TABLE "calendar_feed" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"token_hash" char(64) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_feed_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "calendar_feed_hash_chk" CHECK ("calendar_feed"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"role" text NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_role_chk" CHECK ("chat_message"."role" in ('user', 'assistant', 'tool')),
	CONSTRAINT "chat_message_content_len" CHECK (octet_length("chat_message"."content"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "chat_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_thread_id_customer_uq" UNIQUE("id","customer_id"),
	CONSTRAINT "chat_thread_customer_provider_uq" UNIQUE("customer_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "date_override" (
	"provider_id" text NOT NULL,
	"date" date NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"intervals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "date_override_provider_id_date_pk" PRIMARY KEY("provider_id","date"),
	CONSTRAINT "date_override_intervals_chk" CHECK (jsonb_typeof("date_override"."intervals") = 'array' and jsonb_array_length("date_override"."intervals") <= 3)
);
--> statement-breakpoint
CREATE TABLE "provider_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"time_zone" text NOT NULL,
	"accepting" boolean DEFAULT false NOT NULL,
	"min_notice_minutes" integer DEFAULT 0 NOT NULL,
	"horizon_days" integer DEFAULT 14 NOT NULL,
	CONSTRAINT "provider_profile_slug_unique" UNIQUE("slug"),
	CONSTRAINT "provider_slug_chk" CHECK ("provider_profile"."slug" ~ '^[a-z0-9-]{3,40}$'),
	CONSTRAINT "provider_name_len" CHECK (char_length("provider_profile"."display_name") between 1 and 80),
	CONSTRAINT "provider_bio_len" CHECK (char_length("provider_profile"."bio") <= 500),
	CONSTRAINT "provider_notice_chk" CHECK ("provider_profile"."min_notice_minutes" between 0 and 10080),
	CONSTRAINT "provider_horizon_chk" CHECK ("provider_profile"."horizon_days" between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"duration_min" integer NOT NULL,
	"buffer_before_min" integer DEFAULT 0 NOT NULL,
	"buffer_after_min" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "service_id_provider_uq" UNIQUE("id","provider_id"),
	CONSTRAINT "service_name_len" CHECK (char_length("service"."name") between 1 and 80),
	CONSTRAINT "service_desc_len" CHECK (char_length("service"."description") <= 500),
	CONSTRAINT "service_duration_chk" CHECK ("service"."duration_min" between 15 and 240 and "service"."duration_min" % 5 = 0),
	CONSTRAINT "service_buffer_chk" CHECK ("service"."buffer_before_min" between 0 and 60 and "service"."buffer_after_min" between 0 and 60)
);
--> statement-breakpoint
CREATE TABLE "weekly_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"weekday" integer NOT NULL,
	"start_min" integer NOT NULL,
	"end_min" integer NOT NULL,
	CONSTRAINT "weekly_hours_weekday_chk" CHECK ("weekly_hours"."weekday" between 1 and 7),
	CONSTRAINT "weekly_hours_span_chk" CHECK ("weekly_hours"."start_min" >= 0 and "weekly_hours"."end_min" <= 1440 and "weekly_hours"."start_min" < "weekly_hours"."end_min" and "weekly_hours"."start_min" % 15 = 0 and "weekly_hours"."end_min" % 15 = 0)
);
--> statement-breakpoint
DROP TABLE "item" CASCADE;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_provider_id_user_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_service_provider_fk" FOREIGN KEY ("service_id","provider_id") REFERENCES "public"."service"("id","provider_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_proposal" ADD CONSTRAINT "booking_proposal_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_proposal" ADD CONSTRAINT "booking_proposal_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_proposal" ADD CONSTRAINT "booking_proposal_thread_fk" FOREIGN KEY ("thread_id","customer_id") REFERENCES "public"."chat_thread"("id","customer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_provider_id_provider_profile_user_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profile"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_thread_customer_fk" FOREIGN KEY ("thread_id","customer_id") REFERENCES "public"."chat_thread"("id","customer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread" ADD CONSTRAINT "chat_thread_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread" ADD CONSTRAINT "chat_thread_provider_id_provider_profile_user_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profile"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_override" ADD CONSTRAINT "date_override_provider_id_provider_profile_user_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profile"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_profile" ADD CONSTRAINT "provider_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_provider_id_provider_profile_user_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profile"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_hours" ADD CONSTRAINT "weekly_hours_provider_id_provider_profile_user_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profile"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_provider_starts_idx" ON "booking" USING btree ("provider_id","starts_at");--> statement-breakpoint
CREATE INDEX "booking_customer_starts_idx" ON "booking" USING btree ("customer_id","starts_at");--> statement-breakpoint
CREATE INDEX "chat_message_thread_id_idx" ON "chat_message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "service_provider_id_idx" ON "service" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "weekly_hours_provider_id_idx" ON "weekly_hours" USING btree ("provider_id");