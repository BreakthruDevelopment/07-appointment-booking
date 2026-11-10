-- Drizzle can't express EXCLUDE. btree_gist lets one gist index compare text equality and range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
-- Confirmed bookings for one provider can't have overlapping blocked ranges
-- ([start − buffer before, end + buffer after)).
ALTER TABLE "booking" ADD CONSTRAINT "booking_provider_blocked_excl" EXCLUDE USING gist ("provider_id" WITH =, "blocked" WITH &&) WHERE ("status" = 'confirmed');
--> statement-breakpoint
-- A customer can't hold two confirmed appointments that overlap anywhere.
ALTER TABLE "booking" ADD CONSTRAINT "booking_customer_slot_excl" EXCLUDE USING gist ("customer_id" WITH =, "slot" WITH &&) WHERE ("status" = 'confirmed');
