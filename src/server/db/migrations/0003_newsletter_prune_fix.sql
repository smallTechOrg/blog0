-- Hand-written (Phase 7 qa fix B3 + R5; capability newsletter-list.md "IP retention"). 0002_newsletter is
-- already applied on existing databases, so the prune function is replaced here, never edited there.
-- `newsletter_prune_event_ips(subscriber)` nulled EVERY event IP of a subscriber, so a re-signup after an
-- old unsubscribe lost the fresh signup event's IP the moment the old confirmation aged out. It now
-- takes the retention bar and nulls only events created strictly before it. SECURITY DEFINER functions
-- pin `search_path` (public, then pg_temp last) so no caller-controlled schema can shadow the table.
-- Plain PL/pgSQL, no extensions (runs on PGlite too).
DROP FUNCTION IF EXISTS newsletter_prune_event_ips(uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION newsletter_prune_event_ips(p_subscriber_id uuid, p_before timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('blog0.newsletter_prune', '1', true);
  UPDATE newsletter_subscriber_event SET ip = NULL
    WHERE subscriber_id = p_subscriber_id AND ip IS NOT NULL AND created_at < p_before;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('blog0.newsletter_prune', '0', true);
  RETURN n;
END
$$;
