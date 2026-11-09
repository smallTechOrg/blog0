ALTER TABLE "newsletter_subscriber_event" DROP CONSTRAINT "newsletter_subscriber_event_kind_check";--> statement-breakpoint
ALTER TABLE "newsletter_suppression" DROP CONSTRAINT "newsletter_suppression_reason_check";--> statement-breakpoint
ALTER TABLE "newsletter_suppression" ADD COLUMN "email_hash" text;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "privacy_text" text DEFAULT 'This page explains what we collect when you subscribe to the newsletter, why, and how to have your data erased.

What we collect. When you sign up we store your email address, your name if you gave one, the page you signed up from, your IP address and your browser’s user agent. When you confirm, we store the IP address and user agent of that click too. We also keep the consent text you saw and when you agreed to it.

Why. Your email address is how we send you the newsletter. The rest is proof that you asked for it: we can show when and how you subscribed and that you confirmed by clicking the link in the confirmation email. We never share or sell the list.

How long. IP addresses are deleted twelve months after you confirm. Your email address, the consent record and your unsubscribe history are kept while you are subscribed, and afterwards so that we never email you again once you have unsubscribed.

Who handles it. Issues are delivered by the email-sending service we use. It receives your email address and name only to deliver the newsletter.

Unsubscribing. Every issue ends with an unsubscribe link that works in one click. After that we keep your address on a do-not-send list so you are not emailed again.

Erasure. To have your personal data erased, email us at the contact address below. We remove your email address, IP addresses and other details from our records and keep only an anonymous marker that an address was erased, so we do not email it again by mistake.' NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "newsletter_postal_address" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "newsletter_erase_salt" text DEFAULT encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex') NOT NULL;--> statement-breakpoint
CREATE INDEX "newsletter_suppression_site_email_hash_idx" ON "newsletter_suppression" USING btree ("site_id","email_hash");--> statement-breakpoint
ALTER TABLE "newsletter_subscriber_event" ADD CONSTRAINT "newsletter_subscriber_event_kind_check" CHECK ("newsletter_subscriber_event"."kind" in ('signup', 'confirmation_sent', 'confirmed', 'resubscribed', 'unsubscribed', 'bounced', 'legacy_confirmation_sent', 'provider_synced', 'provider_removed', 'ip_pruned', 'erased'));--> statement-breakpoint
ALTER TABLE "newsletter_suppression" ADD CONSTRAINT "newsletter_suppression_reason_check" CHECK ("newsletter_suppression"."reason" in ('unsubscribed', 'bounced', 'complaint', 'admin', 'erased'));--> statement-breakpoint
-- Hand-written (fix pass; spec/data.md `0004_newsletter_erasure`, capability newsletter-list.md "Erasure").
-- 1) The ledger guard learns one more sanctioned exception, exactly like `newsletter_prune_event_ips`
--    does for `ip`: under `blog0.newsletter_erase = '1'` (set LOCAL by `newsletter_erase_subscriber`
--    below, so it cannot leak past the transaction) a subscriber event / suppression row may be
--    redacted — and ONLY that: the PII columns become the tombstone / NULL / '{}', every other column
--    (kind, source, reason, actor, created_at, ids) must stay identical. Anything else still raises.
--    Plain PL/pgSQL, no extensions (PGlite too). Nested IFs on purpose (see 0002: NEW.ip / NEW.reason
--    may only be referenced once the table is known).
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
    IF current_setting('blog0.newsletter_erase', true) = '1'
       AND NEW.email LIKE 'erased+%@erased.invalid'
       AND NEW.ip IS NULL AND NEW.user_agent IS NULL AND NEW.details = '{}'::jsonb
       AND NEW.id = OLD.id AND NEW.site_id = OLD.site_id AND NEW.subscriber_id = OLD.subscriber_id
       AND NEW.kind = OLD.kind AND NEW.source = OLD.source
       AND NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
       AND NEW.created_at = OLD.created_at THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'newsletter_suppression' AND TG_OP = 'UPDATE' THEN
    IF current_setting('blog0.newsletter_erase', true) = '1'
       AND NEW.email LIKE 'erased+%@erased.invalid'
       AND NEW.details = '{}'::jsonb
       AND NEW.id = OLD.id AND NEW.site_id = OLD.site_id AND NEW.subscriber_id = OLD.subscriber_id
       AND NEW.reason = OLD.reason AND NEW.source = OLD.source AND NEW.created_at = OLD.created_at THEN
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
-- 2) `newsletter_erase_subscriber(subscriber)`: redacts every personal datum of ONE subscriber and
--    leaves the proof that an erasure happened. The tombstone `erased+<hash>@erased.invalid` carries
--    hash = sha256hex(site.newsletter_erase_salt || ':' || trim(lower(email))) — the app computes the
--    same hash (`erasureHash`) to recognise a later signup of the same address without the address
--    ever being stored. Returns false when the subscriber is unknown or already erased (an `erased`
--    event exists). SECURITY DEFINER pins `search_path` (public, pg_temp last) like 0003.
CREATE OR REPLACE FUNCTION newsletter_erase_subscriber(p_subscriber_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_sub newsletter_subscriber%ROWTYPE;
  v_salt text;
  v_hash text;
  v_tomb text;
BEGIN
  SELECT * INTO v_sub FROM newsletter_subscriber WHERE id = p_subscriber_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM newsletter_subscriber_event WHERE subscriber_id = p_subscriber_id AND kind = 'erased') THEN
    RETURN false;
  END IF;
  SELECT newsletter_erase_salt INTO v_salt FROM site WHERE id = v_sub.site_id;
  v_hash := encode(sha256(convert_to(v_salt || ':' || lower(btrim(v_sub.email)), 'UTF8')), 'hex');
  v_tomb := 'erased+' || v_hash || '@erased.invalid';

  PERFORM set_config('blog0.newsletter_erase', '1', true);
  UPDATE newsletter_subscriber_event
    SET email = v_tomb, ip = NULL, user_agent = NULL, details = '{}'::jsonb
    WHERE subscriber_id = p_subscriber_id;
  UPDATE newsletter_suppression
    SET email = v_tomb, email_hash = v_hash, details = '{}'::jsonb
    WHERE subscriber_id = p_subscriber_id;
  PERFORM set_config('blog0.newsletter_erase', '0', true);

  UPDATE newsletter_message
    SET to_email = v_tomb, subject = '[erased]', html = '[erased]', "text" = '[erased]',
        error = CASE WHEN error IS NULL THEN NULL ELSE '[erased]' END
    WHERE subscriber_id = p_subscriber_id;

  UPDATE newsletter_subscriber
    SET email = v_tomb, name = NULL, status = 'unsubscribed',
        unsubscribed_at = COALESCE(unsubscribed_at, now()),
        signup_ip = NULL, signup_user_agent = NULL, signup_source_url = NULL,
        confirmed_ip = NULL, confirmed_user_agent = NULL,
        confirm_token_hash = NULL, confirm_token_expires_at = NULL,
        provider_id = NULL, updated_at = now()
    WHERE id = p_subscriber_id;

  INSERT INTO newsletter_suppression (site_id, subscriber_id, email, reason, source, details, email_hash)
    VALUES (v_sub.site_id, p_subscriber_id, v_tomb, 'erased', 'admin', '{}'::jsonb, v_hash);
  INSERT INTO newsletter_subscriber_event (site_id, subscriber_id, email, kind, source, details)
    VALUES (v_sub.site_id, p_subscriber_id, v_tomb, 'erased', 'admin', '{}'::jsonb);
  RETURN true;
END
$$;--> statement-breakpoint
-- 3) One-off: stored confirmation messages carried the live confirm token (a database copy could
--    confirm an address). New rows are redacted by the app before insert (`redactConfirmUrl`).
UPDATE newsletter_message
  SET html = regexp_replace(html, '(/newsletter/confirm\?t=)[^"&\s<]+', '\1[redacted]', 'g'),
      "text" = regexp_replace("text", '(/newsletter/confirm\?t=)[^"&\s<]+', '\1[redacted]', 'g')
  WHERE kind = 'confirmation';
