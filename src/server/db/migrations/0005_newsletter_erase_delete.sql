CREATE TABLE "newsletter_erasure_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"source" text NOT NULL,
	"erased_by" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_outcome" text DEFAULT 'pending' NOT NULL,
	"provider_ref" text,
	"provider_checked_at" timestamp with time zone,
	"erased_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_erasure_log_source_check" CHECK ("newsletter_erasure_log"."source" in ('admin', 'migration')),
	CONSTRAINT "newsletter_erasure_log_provider_outcome_check" CHECK ("newsletter_erasure_log"."provider_outcome" in ('pending', 'deleted', 'not_found', 'kept', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "newsletter_erasure_marker" (
	"site_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_erasure_marker_pk" PRIMARY KEY("site_id","email_hash")
);
--> statement-breakpoint
ALTER TABLE "newsletter_issue" ADD COLUMN "erased_message_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletter_erasure_log" ADD CONSTRAINT "newsletter_erasure_log_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_erasure_log" ADD CONSTRAINT "newsletter_erasure_log_erased_by_app_user_id_fk" FOREIGN KEY ("erased_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_erasure_log" ADD CONSTRAINT "newsletter_erasure_log_marker_fk" FOREIGN KEY ("site_id","email_hash") REFERENCES "public"."newsletter_erasure_marker"("site_id","email_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_erasure_marker" ADD CONSTRAINT "newsletter_erasure_marker_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "newsletter_erasure_log_site_erased_idx" ON "newsletter_erasure_log" USING btree ("site_id","erased_at" DESC NULLS LAST);--> statement-breakpoint
-- Hand-written (owner decision 2026-10-19; capability newsletter-list.md "Erasure", spec/data.md
-- `0005_newsletter_erase_delete`). 0004 tombstoned an erased subscriber with an address derived
-- deterministically from the hash, so erase → re-subscribe → erase collided on
-- newsletter_subscriber_site_email_unique (23505 → a 500 in the admin). Erasure now DELETES every row
-- holding the person's data and keeps only (a) the keyed-hash marker "never email this address"
-- (`newsletter_erasure_marker`) and (b) a PII-free audit row (`newsletter_erasure_log`).
-- Plain PL/pgSQL, no extensions — identical on PostgreSQL 18 and PGlite.
--
-- 1) The ledger guard: the 0004 "redact to the tombstone" UPDATE exceptions are gone (nothing redacts
--    any more). New sanctioned exception, same pattern as 0003's prune flag: a DELETE of a subscriber
--    event / suppression row passes ONLY when its subscriber_id is in `blog0.newsletter_erase_ids`
--    (set LOCAL by `newsletter_erase_subscriber` below for the subscribers it is deleting, cleared
--    right after). Every other UPDATE / DELETE still raises.
CREATE OR REPLACE FUNCTION newsletter_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
  IF TG_TABLE_NAME IN ('newsletter_subscriber_event', 'newsletter_suppression') AND TG_OP = 'DELETE' THEN
    IF OLD.subscriber_id::text = ANY (string_to_array(coalesce(current_setting('blog0.newsletter_erase_ids', true), ''), ',')) THEN
      RETURN OLD;
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
-- 2) The erasure records are insert-only: a marker never changes or goes; an audit row never goes and
--    only its provider columns (outcome, provider ref, checked-at) may change (the Listmonk step runs
--    after the erase commits and may be retried).
CREATE OR REPLACE FUNCTION newsletter_erasure_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'newsletter_erasure_log' AND TG_OP = 'UPDATE' THEN
    IF NEW.id = OLD.id AND NEW.site_id = OLD.site_id AND NEW.email_hash = OLD.email_hash
       AND NEW.source = OLD.source AND NEW.erased_by IS NOT DISTINCT FROM OLD.erased_by
       AND NEW.details = OLD.details AND NEW.erased_at = OLD.erased_at THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'newsletter erasure record is append-only: % on % refused', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER newsletter_erasure_marker_guard BEFORE UPDATE OR DELETE ON "newsletter_erasure_marker" FOR EACH ROW EXECUTE FUNCTION newsletter_erasure_guard();--> statement-breakpoint
CREATE TRIGGER newsletter_erasure_log_guard BEFORE UPDATE OR DELETE ON "newsletter_erasure_log" FOR EACH ROW EXECUTE FUNCTION newsletter_erasure_guard();--> statement-breakpoint
-- 3) An erased address can come back ONLY through a fresh double opt-in signup: a new subscriber row
--    whose address matches a marker must start `pending` — an import, a restore script or any other
--    direct insert of a `confirmed` / `legacy_unconfirmed` / suppressed row raises. The message names
--    no address.
CREATE OR REPLACE FUNCTION newsletter_subscriber_erased_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status <> 'pending' AND EXISTS (
    SELECT 1 FROM newsletter_erasure_marker m JOIN site s ON s.id = m.site_id
    WHERE m.site_id = NEW.site_id
      AND m.email_hash = encode(sha256(convert_to(s.newsletter_erase_salt || ':' || lower(btrim(NEW.email)), 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'newsletter: this address was erased — it can only be re-added by a new double opt-in signup'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER newsletter_subscriber_erased_guard BEFORE INSERT ON "newsletter_subscriber" FOR EACH ROW EXECUTE FUNCTION newsletter_subscriber_erased_guard();--> statement-breakpoint
-- 4) `newsletter_erase_subscriber(subscriber, erased_by, source)` → jsonb. In the caller's transaction:
--    a) hash = sha256hex(site.newsletter_erase_salt || ':' || lower(btrim(email))) (the app's
--       `erasureHash`); for a 0004 tombstone row the hash is read from its address; the marker
--       (site, hash) is inserted if missing (idempotent);
--    b) every subscriber row of that person on the site — the given one, any row with the same address,
--       any 0004 tombstone `erased+<hash>@erased.invalid` — is deleted with its events, suppressions and
--       messages (and any suppression / message row addressed to it); `kind 'issue'` messages first add
--       to their issue's `erased_message_count` so issue stats / recipient counts stay intact;
--    c) one PII-free `newsletter_erasure_log` row (site, hash, source, erased_by, row counts);
--    d) returns `{"erased": true, "erasureId", "subscribers", "events", "messages", "suppressions"}`,
--       or `{"erased": false}` for an unknown id (already deleted — e.g. a concurrent erase).
--    SECURITY DEFINER pins search_path (public, pg_temp last) like 0003/0004.
DROP FUNCTION IF EXISTS newsletter_erase_subscriber(uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION newsletter_erase_subscriber(p_subscriber_id uuid, p_erased_by uuid DEFAULT NULL, p_source text DEFAULT 'admin') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_sub newsletter_subscriber%ROWTYPE;
  v_salt text;
  v_norm text;
  v_hash text;
  v_tomb text;
  v_ids uuid[];
  v_at timestamptz;
  v_log uuid;
  n_sub integer;
  n_ev integer;
  n_msg integer;
  n_sup integer;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('admin', 'migration') THEN
    RAISE EXCEPTION 'newsletter_erase_subscriber: unknown source %', p_source USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_sub FROM newsletter_subscriber WHERE id = p_subscriber_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('erased', false);
  END IF;
  SELECT newsletter_erase_salt INTO v_salt FROM site WHERE id = v_sub.site_id;
  v_norm := lower(btrim(v_sub.email));
  IF v_norm ~ '^erased\+[0-9a-f]{64}@erased\.invalid$' THEN
    v_hash := substr(v_norm, 8, 64);
  ELSE
    v_hash := encode(sha256(convert_to(v_salt || ':' || v_norm, 'UTF8')), 'hex');
  END IF;
  v_tomb := 'erased+' || v_hash || '@erased.invalid';

  PERFORM 1 FROM newsletter_subscriber
    WHERE site_id = v_sub.site_id AND (id = p_subscriber_id OR lower(btrim(email)) IN (v_norm, v_tomb))
    FOR UPDATE;
  SELECT array_agg(id) INTO v_ids FROM newsletter_subscriber
    WHERE site_id = v_sub.site_id AND (id = p_subscriber_id OR lower(btrim(email)) IN (v_norm, v_tomb));

  -- when the request was honoured: now, or (repairing a 0004 tombstone) the time of its `erased` event
  v_at := now();
  IF p_source = 'migration' THEN
    SELECT coalesce(min(created_at), now()) INTO v_at FROM newsletter_subscriber_event
      WHERE subscriber_id = ANY (v_ids) AND kind = 'erased';
  END IF;

  INSERT INTO newsletter_erasure_marker (site_id, email_hash, created_at) VALUES (v_sub.site_id, v_hash, v_at)
    ON CONFLICT (site_id, email_hash) DO NOTHING;

  UPDATE newsletter_issue i SET erased_message_count = i.erased_message_count + c.n
    FROM (
      SELECT issue_id, count(*)::integer AS n FROM newsletter_message
      WHERE site_id = v_sub.site_id AND kind = 'issue' AND issue_id IS NOT NULL
        AND (subscriber_id = ANY (v_ids) OR lower(btrim(to_email)) IN (v_norm, v_tomb))
      GROUP BY issue_id
    ) c
    WHERE i.id = c.issue_id;
  DELETE FROM newsletter_message
    WHERE subscriber_id = ANY (v_ids) OR (site_id = v_sub.site_id AND lower(btrim(to_email)) IN (v_norm, v_tomb));
  GET DIAGNOSTICS n_msg = ROW_COUNT;

  PERFORM set_config('blog0.newsletter_erase_ids', array_to_string(v_ids, ','), true);
  DELETE FROM newsletter_subscriber_event WHERE subscriber_id = ANY (v_ids);
  GET DIAGNOSTICS n_ev = ROW_COUNT;
  DELETE FROM newsletter_suppression
    WHERE subscriber_id = ANY (v_ids) OR (site_id = v_sub.site_id AND lower(btrim(email)) IN (v_norm, v_tomb));
  GET DIAGNOSTICS n_sup = ROW_COUNT;
  PERFORM set_config('blog0.newsletter_erase_ids', '', true);

  DELETE FROM newsletter_subscriber WHERE id = ANY (v_ids);
  GET DIAGNOSTICS n_sub = ROW_COUNT;

  INSERT INTO newsletter_erasure_log (site_id, email_hash, source, erased_by, details, provider_outcome, erased_at)
    VALUES (v_sub.site_id, v_hash, p_source, p_erased_by,
            jsonb_build_object('subscribers', n_sub, 'events', n_ev, 'messages', n_msg, 'suppressions', n_sup),
            CASE WHEN p_source = 'migration' THEN 'skipped' ELSE 'pending' END, v_at)
    RETURNING id INTO v_log;

  RETURN jsonb_build_object('erased', true, 'erasureId', v_log, 'subscribers', n_sub, 'events', n_ev, 'messages', n_msg, 'suppressions', n_sup);
END
$$;--> statement-breakpoint
-- 5) Repair: every 0004 tombstone (`erased+<hash>@erased.invalid`) becomes the new state — deleted with
--    its events / suppressions / messages, its hash kept as a marker, one audit row (source `migration`,
--    dated by its `erased` event; provider `skipped` — 0004 already handled the provider copy).
--    A site holding two tombstones of one hash is repaired by the first call (the second id is gone).
SELECT newsletter_erase_subscriber(t.id, NULL, 'migration')
  FROM (SELECT id FROM newsletter_subscriber WHERE email ~ '^erased\+[0-9a-f]{64}@erased\.invalid$' ORDER BY created_at, id) t;
