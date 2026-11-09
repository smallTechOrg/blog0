CREATE TABLE "ai_generation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"format_kind" text NOT NULL,
	"task" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"sentence_count" integer NOT NULL,
	"bound_min" integer NOT NULL,
	"bound_max" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"provider_generation_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"output" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_generation_status_check" CHECK ("ai_generation"."status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"slug_is_custom" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"byline_name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"current_revision_id" uuid,
	"published_revision_id" uuid,
	"is_featured" boolean DEFAULT false NOT NULL,
	"featured_rank" integer,
	"in_progress" boolean DEFAULT false NOT NULL,
	"first_published_at" timestamp with time zone,
	"last_published_at" timestamp with time zone,
	"content_updated_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"submitted_by" uuid,
	"approved_by" uuid,
	"corrections_note_md" text,
	"corrections_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_status_check" CHECK ("article"."status" in ('draft', 'submitted', 'approved', 'published'))
);
--> statement-breakpoint
CREATE TABLE "article_format" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"draft_payload" jsonb,
	"draft_revision_id" uuid,
	"draft_fingerprint" text,
	"draft_updated_by" uuid,
	"draft_updated_at" timestamp with time zone,
	"published_payload" jsonb,
	"published_revision_id" uuid,
	"published_fingerprint" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"dek" text DEFAULT '' NOT NULL,
	"body_md" text NOT NULL,
	"body_fingerprint" text NOT NULL,
	"paragraphs_fingerprint" text NOT NULL,
	"sentences_fingerprint" text NOT NULL,
	"word_count" integer NOT NULL,
	"eligible_sentence_count" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"restored_from_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"duration_sec" numeric(10, 3),
	"width" integer,
	"height" integer,
	"article_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_asset_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "media_asset_kind_check" CHECK ("media_asset"."kind" in ('image', 'audio'))
);
--> statement-breakpoint
CREATE TABLE "newsletter_subscriber" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'subscribed' NOT NULL,
	"source" text DEFAULT 'footer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_subscriber_status_check" CHECK ("newsletter_subscriber"."status" in ('subscribed', 'unsubscribed'))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"ip" text,
	CONSTRAINT "session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "site" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"brand_name" text NOT NULL,
	"wordmark" text NOT NULL,
	"publisher_name" text NOT NULL,
	"tagline" text NOT NULL,
	"contact_email" text NOT NULL,
	"about_strap" text NOT NULL,
	"about_stand" text NOT NULL,
	"about_body_md" text NOT NULL,
	"social_x_url" text,
	"social_linkedin_url" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_article_id_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."article"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_revision_id_article_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."article_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article" ADD CONSTRAINT "article_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article" ADD CONSTRAINT "article_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article" ADD CONSTRAINT "article_current_revision_id_article_revision_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."article_revision"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article" ADD CONSTRAINT "article_published_revision_id_article_revision_id_fk" FOREIGN KEY ("published_revision_id") REFERENCES "public"."article_revision"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article" ADD CONSTRAINT "article_submitted_by_app_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article" ADD CONSTRAINT "article_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_format" ADD CONSTRAINT "article_format_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_format" ADD CONSTRAINT "article_format_article_id_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."article"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_format" ADD CONSTRAINT "article_format_draft_revision_id_article_revision_id_fk" FOREIGN KEY ("draft_revision_id") REFERENCES "public"."article_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_format" ADD CONSTRAINT "article_format_draft_updated_by_app_user_id_fk" FOREIGN KEY ("draft_updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_format" ADD CONSTRAINT "article_format_published_revision_id_article_revision_id_fk" FOREIGN KEY ("published_revision_id") REFERENCES "public"."article_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revision" ADD CONSTRAINT "article_revision_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revision" ADD CONSTRAINT "article_revision_article_id_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."article"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revision" ADD CONSTRAINT "article_revision_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revision" ADD CONSTRAINT "article_revision_restored_from_revision_id_article_revision_id_fk" FOREIGN KEY ("restored_from_revision_id") REFERENCES "public"."article_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_article_id_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."article"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_subscriber" ADD CONSTRAINT "newsletter_subscriber_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_generation_site_started_idx" ON "ai_generation" USING btree ("site_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_generation_article_started_idx" ON "ai_generation" USING btree ("article_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_site_email_unique" ON "app_user" USING btree ("site_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "article_site_slug_unique" ON "article" USING btree ("site_id","slug");--> statement-breakpoint
CREATE INDEX "article_site_status_published_idx" ON "article" USING btree ("site_id","status","first_published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "article_site_featured_idx" ON "article" USING btree ("site_id","is_featured","featured_rank");--> statement-breakpoint
CREATE UNIQUE INDEX "article_format_article_kind_unique" ON "article_format" USING btree ("article_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "article_revision_article_number_unique" ON "article_revision" USING btree ("article_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_subscriber_site_email_unique" ON "newsletter_subscriber" USING btree ("site_id","email");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");