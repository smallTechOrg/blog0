CREATE TABLE "rate_limit_bucket" (
	"site_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key_hash" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_bucket_pk" PRIMARY KEY("site_id","scope","key_hash","window_start"),
	CONSTRAINT "rate_limit_bucket_count_check" CHECK ("rate_limit_bucket"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "rate_limit_bucket" ADD CONSTRAINT "rate_limit_bucket_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_limit_bucket_expires_idx" ON "rate_limit_bucket" USING btree ("expires_at");