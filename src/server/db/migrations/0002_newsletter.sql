CREATE TABLE "newsletter_issue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"origin" text NOT NULL,
	"title" text NOT NULL,
	"intro_md" text DEFAULT '' NOT NULL,
	"posts" jsonb NOT NULL,
	"article_ids" uuid[] NOT NULL,
	"rendered_html" text,
	"rendered_text" text,
	"provider_campaign_id" text,
	"recipient_count" integer,
	"stats" jsonb,
	"last_error" text,
	"created_by" uuid,
	"sent_by" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_issue_status_check" CHECK ("newsletter_issue"."status" in ('draft', 'sending', 'sent', 'failed')),
	CONSTRAINT "newsletter_issue_origin_check" CHECK ("newsletter_issue"."origin" in ('per_post', 'digest', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "newsletter_issue_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_issue_event_kind_check" CHECK ("newsletter_issue_event"."kind" in ('created', 'updated', 'test_sent', 'send_requested', 'provider_created', 'provider_started', 'sent', 'failed', 'stats_fetched', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "newsletter_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subscriber_id" uuid,
	"issue_id" uuid,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"transport" text NOT NULL,
	"status" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_message_kind_check" CHECK ("newsletter_message"."kind" in ('confirmation', 'test_issue', 'issue')),
	CONSTRAINT "newsletter_message_status_check" CHECK ("newsletter_message"."status" in ('sent', 'failed', 'stubbed'))
);
--> statement-breakpoint
CREATE TABLE "newsletter_subscriber_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"actor_user_id" uuid,
	"ip" text,
	"user_agent" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_subscriber_event_kind_check" CHECK ("newsletter_subscriber_event"."kind" in ('signup', 'confirmation_sent', 'confirmed', 'resubscribed', 'unsubscribed', 'bounced', 'legacy_confirmation_sent', 'provider_synced', 'provider_removed', 'ip_pruned')),
	CONSTRAINT "newsletter_subscriber_event_source_check" CHECK ("newsletter_subscriber_event"."source" in ('footer', 'email_link', 'one_click', 'admin', 'provider', 'webhook', 'migration', 'system'))
);
--> statement-breakpoint
CREATE TABLE "newsletter_suppression" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_suppression_reason_check" CHECK ("newsletter_suppression"."reason" in ('unsubscribed', 'bounced', 'complaint', 'admin')),
	CONSTRAINT "newsletter_suppression_source_check" CHECK ("newsletter_suppression"."source" in ('footer', 'email_link', 'one_click', 'admin', 'provider', 'webhook', 'migration', 'system'))
);
--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" DROP CONSTRAINT "newsletter_subscriber_status_check";--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "signup_source_url" text;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "signup_ip" text;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "signup_user_agent" text;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "consent_text" text;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "consent_version" text;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "consented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "confirm_token_hash" text;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "confirm_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "confirmation_sent_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "legacy_confirmation_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "confirmed_ip" text;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "confirmed_user_agent" text;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "unsubscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "provider_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD COLUMN "ip_pruned_at" timestamp with time zone;--> statement-breakpoint
-- Hand-written (slice S7.1, spec/data.md → newsletter_subscriber): every Phase 2 `subscribed` row becomes
-- `legacy_unconfirmed` BEFORE the widened CHECK is added below (the old CHECK was dropped above).
-- Legacy rows are kept, exported and visible, never sent an issue until they confirm.
UPDATE "newsletter_subscriber" SET "status" = 'legacy_unconfirmed', "source" = 'legacy' WHERE "status" = 'subscribed';--> statement-breakpoint
UPDATE "newsletter_subscriber" SET "unsubscribed_at" = "updated_at" WHERE "status" = 'unsubscribed' AND "unsubscribed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "newsletter_mode" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "newsletter_auto_send" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "newsletter_digest_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "newsletter_digest_posts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "newsletter_consent_text" text DEFAULT 'One issue a week at most. Unsubscribe in one click; we never share the list.' NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "newsletter_consent_version" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "newsletter_mode_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "newsletter_issue" ADD CONSTRAINT "newsletter_issue_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_issue" ADD CONSTRAINT "newsletter_issue_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_issue" ADD CONSTRAINT "newsletter_issue_sent_by_app_user_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_issue_event" ADD CONSTRAINT "newsletter_issue_event_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_issue_event" ADD CONSTRAINT "newsletter_issue_event_issue_id_newsletter_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."newsletter_issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_issue_event" ADD CONSTRAINT "newsletter_issue_event_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_message" ADD CONSTRAINT "newsletter_message_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_message" ADD CONSTRAINT "newsletter_message_subscriber_id_newsletter_subscriber_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."newsletter_subscriber"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_message" ADD CONSTRAINT "newsletter_message_issue_id_newsletter_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."newsletter_issue"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber_event" ADD CONSTRAINT "newsletter_subscriber_event_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber_event" ADD CONSTRAINT "newsletter_subscriber_event_subscriber_id_newsletter_subscriber_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."newsletter_subscriber"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber_event" ADD CONSTRAINT "newsletter_subscriber_event_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_suppression" ADD CONSTRAINT "newsletter_suppression_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_suppression" ADD CONSTRAINT "newsletter_suppression_subscriber_id_newsletter_subscriber_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."newsletter_subscriber"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_issue_site_number_unique" ON "newsletter_issue" USING btree ("site_id","number");--> statement-breakpoint
CREATE INDEX "newsletter_issue_site_created_idx" ON "newsletter_issue" USING btree ("site_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "newsletter_issue_site_status_idx" ON "newsletter_issue" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "newsletter_issue_event_issue_idx" ON "newsletter_issue_event" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "newsletter_message_site_created_idx" ON "newsletter_message" USING btree ("site_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "newsletter_message_subscriber_created_idx" ON "newsletter_message" USING btree ("subscriber_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "newsletter_message_issue_idx" ON "newsletter_message" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "newsletter_subscriber_event_subscriber_idx" ON "newsletter_subscriber_event" USING btree ("subscriber_id","created_at");--> statement-breakpoint
CREATE INDEX "newsletter_subscriber_event_site_created_idx" ON "newsletter_subscriber_event" USING btree ("site_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "newsletter_suppression_site_email_idx" ON "newsletter_suppression" USING btree ("site_id","email","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_subscriber_confirm_token_unique" ON "newsletter_subscriber" USING btree ("confirm_token_hash") WHERE "newsletter_subscriber"."confirm_token_hash" is not null;--> statement-breakpoint
CREATE INDEX "newsletter_subscriber_site_status_idx" ON "newsletter_subscriber" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "newsletter_subscriber_site_confirmed_idx" ON "newsletter_subscriber" USING btree ("site_id","confirmed_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD CONSTRAINT "newsletter_subscriber_status_check" CHECK ("newsletter_subscriber"."status" in ('pending', 'confirmed', 'unsubscribed', 'bounced', 'legacy_unconfirmed'));--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_newsletter_mode_check" CHECK ("site"."newsletter_mode" in ('per_post', 'digest', 'manual'));--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_newsletter_digest_days_check" CHECK ("site"."newsletter_digest_days" between 1 and 60);--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_newsletter_digest_posts_check" CHECK ("site"."newsletter_digest_posts" between 1 and 20);--> statement-breakpoint
-- Hand-written (slice S7.1, spec/data.md → newsletter_subscriber_event / newsletter_suppression /
-- newsletter_issue_event): the ledger guard. Plain PL/pgSQL, no extensions (runs on PGlite too).
-- UPDATE and DELETE raise on the three append-only tables, with two sanctioned exceptions:
--   * `newsletter_prune_event_ips()` below sets `blog0.newsletter_prune = '1'` for its transaction and
--     may null `ip` on a subscriber event — nothing else may change on that row;
--   * deleting a draft newsletter_issue cascades to its events (the parent row is already gone when
--     the row trigger fires), so a DELETE on newsletter_issue_event whose issue no longer exists passes.
CREATE OR REPLACE FUNCTION newsletter_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Nested IFs on purpose: PL/pgSQL evaluates a condition as one SQL expression, so NEW.ip / OLD.issue_id
  -- may only be referenced once the table is known to have that column.
  IF TG_TABLE_NAME = 'newsletter_subscriber_event' AND TG_OP = 'UPDATE' THEN
    IF current_setting('blog0.newsletter_prune', true) = '1'
       AND NEW.ip IS NULL
       AND NEW.id = OLD.id AND NEW.site_id = OLD.site_id AND NEW.subscriber_id = OLD.subscriber_id
       AND NEW.email = OLD.email AND NEW.kind = OLD.kind AND NEW.source = OLD.source
       AND NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
       AND NEW.user_agent IS NOT DISTINCT FROM OLD.user_agent
       AND NEW.details = OLD.details AND NEW.created_at = OLD.created_at THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'newsletter_issue_event' AND TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM newsletter_issue WHERE id = OLD.issue_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'newsletter ledger is append-only: % on % refused', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER newsletter_subscriber_event_ledger_guard BEFORE UPDATE OR DELETE ON "newsletter_subscriber_event" FOR EACH ROW EXECUTE FUNCTION newsletter_ledger_guard();--> statement-breakpoint
CREATE TRIGGER newsletter_suppression_ledger_guard BEFORE UPDATE OR DELETE ON "newsletter_suppression" FOR EACH ROW EXECUTE FUNCTION newsletter_ledger_guard();--> statement-breakpoint
CREATE TRIGGER newsletter_issue_event_ledger_guard BEFORE UPDATE OR DELETE ON "newsletter_issue_event" FOR EACH ROW EXECUTE FUNCTION newsletter_ledger_guard();--> statement-breakpoint
-- The 12-month IP retention rule (spec/architecture.md §13.1 prune.ts): the only sanctioned update of an
-- event row — it touches `ip` only, for one subscriber, and returns how many rows it nulled.
CREATE OR REPLACE FUNCTION newsletter_prune_event_ips(p_subscriber_id uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('blog0.newsletter_prune', '1', true);
  UPDATE newsletter_subscriber_event SET ip = NULL WHERE subscriber_id = p_subscriber_id AND ip IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('blog0.newsletter_prune', '0', true);
  RETURN n;
END
$$;--> statement-breakpoint
-- Legacy backfill, part 2 (spec/data.md): every pre-Phase-7 `unsubscribed` row gets one permanent
-- suppression row and one `unsubscribed` event, both `source = 'migration'`. Idempotent by construction:
-- this migration runs once, and the rows it inserts are guarded from edits by the trigger above.
INSERT INTO "newsletter_suppression" ("site_id", "subscriber_id", "email", "reason", "source", "details", "created_at")
SELECT s."site_id", s."id", s."email", 'unsubscribed', 'migration', '{"migration":"0002_newsletter"}'::jsonb, s."updated_at"
FROM "newsletter_subscriber" s WHERE s."status" = 'unsubscribed';--> statement-breakpoint
INSERT INTO "newsletter_subscriber_event" ("site_id", "subscriber_id", "email", "kind", "source", "details", "created_at")
SELECT s."site_id", s."id", s."email", 'unsubscribed', 'migration', '{"migration":"0002_newsletter"}'::jsonb, s."updated_at"
FROM "newsletter_subscriber" s WHERE s."status" = 'unsubscribed';
