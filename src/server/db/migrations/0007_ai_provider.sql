CREATE TABLE "ai_provider" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"api_key_sealed" text,
	"api_key_hint" text,
	"last_ok_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_provider" ADD CONSTRAINT "ai_provider_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider" ADD CONSTRAINT "ai_provider_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;