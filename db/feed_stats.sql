-- Aggregate-only analytics RPC used by /stats/.
-- The RPC reads a snapshot refreshed by pg_cron every 10s. Computing the
-- aggregate on every request overwhelmed the anon role's 3s statement_timeout.

CREATE TABLE IF NOT EXISTS public.feed_stats_cache (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  data jsonb NOT NULL,
  refreshed_at timestamptz NOT NULL
);
REVOKE ALL ON TABLE public.feed_stats_cache FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.feed_stats_compute()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
  WITH w AS MATERIALIZED (
    SELECT * FROM feed_events WHERE ts >= now() - interval '7 days'
  ),
  -- One source per session: first non-empty utm_source wins, then the first
  -- referrer host. Sessions with neither are Direct. Avoid array_agg over every
  -- event here: as traffic grew, that sort pushed the RPC past the 3s timeout.
  sessions AS MATERIALIZED (
    SELECT DISTINCT coalesce(nullif(session, ''), 'v:' || visitor) sk FROM w
  ),
  first_utm AS MATERIALIZED (
    SELECT DISTINCT ON (coalesce(nullif(session, ''), 'v:' || visitor))
           coalesce(nullif(session, ''), 'v:' || visitor) sk,
           lower(nullif(btrim(utm_source), '')) source
    FROM w
    WHERE nullif(btrim(utm_source), '') IS NOT NULL
    ORDER BY coalesce(nullif(session, ''), 'v:' || visitor), ts
  ),
  first_ref AS MATERIALIZED (
    SELECT DISTINCT ON (coalesce(nullif(session, ''), 'v:' || visitor))
           coalesce(nullif(session, ''), 'v:' || visitor) sk,
           nullif(regexp_replace(lower(substring(referrer from '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#@]+)')), '^www\.', ''), '') source
    FROM w
    WHERE substring(referrer from '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#@]+)') IS NOT NULL
    ORDER BY coalesce(nullif(session, ''), 'v:' || visitor), ts
  ),
  src AS MATERIALIZED (
    SELECT s.sk,
           coalesce(u.source, r.source, 'Direct') source,
           u.source IS NOT NULL utm_tagged
    FROM sessions s
    LEFT JOIN first_utm u USING (sk)
    LEFT JOIN first_ref r USING (sk)
  ),
  src_rows AS (
    SELECT src.source,
           count(DISTINCT w.visitor) visits,
           count(DISTINCT w.session) FILTER (WHERE nullif(w.session, '') IS NOT NULL) sessions,
           count(*) FILTER (WHERE w.event IN ('play','play_tab')) plays,
           count(*) FILTER (WHERE w.event = 'like') likes
    FROM w JOIN src ON src.sk = coalesce(nullif(w.session, ''), 'v:' || w.visitor)
    GROUP BY 1
  ),
  top_sources AS MATERIALIZED (
    SELECT * FROM src_rows ORDER BY visits DESC, sessions DESC LIMIT 25
  ),
  referrers AS (
    SELECT source, url, visits, plays,
           row_number() OVER (PARTITION BY source ORDER BY visits DESC, plays DESC) rn
    FROM (
      SELECT src.source, w.referrer url,
             count(DISTINCT w.visitor) visits,
             count(*) FILTER (WHERE w.event IN ('play','play_tab')) plays
      FROM w JOIN src ON src.sk = coalesce(nullif(w.session, ''), 'v:' || w.visitor)
      WHERE src.source <> 'Direct' AND nullif(btrim(w.referrer), '') IS NOT NULL
      GROUP BY 1, 2
    ) r
  ),
  landings AS (
    SELECT source, url, visits,
           row_number() OVER (PARTITION BY source ORDER BY visits DESC) rn
    FROM (
      SELECT src.source, w.landing url, count(DISTINCT w.visitor) visits
      FROM w JOIN src ON src.sk = coalesce(nullif(w.session, ''), 'v:' || w.visitor)
      WHERE src.utm_tagged AND nullif(btrim(w.landing), '') IS NOT NULL
      GROUP BY 1, 2
    ) l
  ),
  referrer_json AS (
    SELECT source, json_agg(json_build_object('url', url, 'visits', visits, 'plays', plays)
                            ORDER BY visits DESC, plays DESC)
           FILTER (WHERE rn <= 10) referrers
    FROM referrers GROUP BY 1
  ),
  landing_json AS (
    SELECT source, json_agg(json_build_object('url', url, 'visits', visits)
                            ORDER BY visits DESC)
           FILTER (WHERE rn <= 10) landings
    FROM landings GROUP BY 1
  )
  SELECT json_build_object(
    'now', now(),
    'active_5m', (SELECT count(DISTINCT visitor) FROM w WHERE ts >= now() - interval '5 minutes'),
    'visitors_24h', (SELECT count(DISTINCT visitor) FROM w WHERE ts >= now() - interval '24 hours'),
    'visitors_7d', (SELECT count(DISTINCT visitor) FROM w),
    'totals_24h', (SELECT coalesce(json_object_agg(event, n), '{}'::json) FROM (
        SELECT event, count(*) n FROM w WHERE ts >= now() - interval '24 hours' GROUP BY event) t),
    'watch_seconds_24h', (SELECT coalesce(round(sum(value)), 0) FROM w WHERE event = 'watch' AND ts >= now() - interval '24 hours'),
    'plays_per_min', (SELECT coalesce(json_agg(json_build_object('m', m, 'n', n) ORDER BY m), '[]'::json) FROM (
        SELECT date_trunc('minute', ts) m, count(*) n FROM w
        WHERE event IN ('play','play_tab') AND ts >= now() - interval '60 minutes' GROUP BY 1) t),
    'views_per_min', (SELECT coalesce(json_agg(json_build_object('m', m, 'n', n) ORDER BY m), '[]'::json) FROM (
        SELECT date_trunc('minute', ts) m, count(*) n FROM w
        WHERE event = 'view' AND ts >= now() - interval '60 minutes' GROUP BY 1) t),
    'top_24h', (SELECT coalesce(json_agg(t ORDER BY plays DESC, watch DESC), '[]'::json) FROM (
        SELECT game_id, count(*) FILTER (WHERE event IN ('play','play_tab')) plays,
               round(coalesce(sum(value) FILTER (WHERE event = 'watch'), 0)) watch,
               count(*) FILTER (WHERE event = 'view') views,
               count(*) FILTER (WHERE event = 'like') likes
        FROM w WHERE game_id IS NOT NULL AND ts >= now() - interval '24 hours'
        GROUP BY game_id ORDER BY 2 DESC, 3 DESC LIMIT 15) t),
    'top_7d', (SELECT coalesce(json_agg(t ORDER BY plays DESC, watch DESC), '[]'::json) FROM (
        SELECT game_id, count(*) FILTER (WHERE event IN ('play','play_tab')) plays,
               round(coalesce(sum(value) FILTER (WHERE event = 'watch'), 0)) watch,
               count(*) FILTER (WHERE event = 'view') views,
               count(*) FILTER (WHERE event = 'like') likes
        FROM w WHERE game_id IS NOT NULL
        GROUP BY game_id ORDER BY 2 DESC, 3 DESC LIMIT 15) t),
    'quick_skips_24h', (SELECT coalesce(json_agg(t ORDER BY skips DESC), '[]'::json) FROM (
        SELECT game_id, count(*) FILTER (WHERE value < 2) skips, count(*) watches
        FROM w WHERE event = 'watch' AND game_id IS NOT NULL AND ts >= now() - interval '24 hours'
        GROUP BY game_id HAVING count(*) FILTER (WHERE value < 2) > 0
        ORDER BY 2 DESC LIMIT 15) t),
    'zero_searches_7d', (SELECT coalesce(json_agg(t ORDER BY n DESC), '[]'::json) FROM (
        SELECT lower(search) q, count(*) n FROM w
        WHERE event = 'search' AND coalesce(value, 0) = 0 AND search IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 15) t),
    'top_searches_7d', (SELECT coalesce(json_agg(t ORDER BY n DESC), '[]'::json) FROM (
        SELECT lower(search) q, count(*) n, max(value) results FROM w
        WHERE event = 'search' AND search IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 15) t),
    'top_tags_7d', (SELECT coalesce(json_agg(t ORDER BY n DESC), '[]'::json) FROM (
        SELECT tag, count(*) n FROM w WHERE event = 'tag' AND tag IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 15) t),
    'devices_24h', (SELECT coalesce(json_object_agg(coalesce(device, '?'), n), '{}'::json) FROM (
        SELECT device, count(DISTINCT visitor) n FROM w WHERE ts >= now() - interval '24 hours' GROUP BY device) t),
    'daily_30d', (SELECT coalesce(json_agg(t ORDER BY d), '[]'::json) FROM (
        SELECT date_trunc('day', hour) d,
               sum(count) FILTER (WHERE event = 'view') views,
               sum(count) FILTER (WHERE event IN ('play','play_tab')) plays
        FROM feed_stats_hourly WHERE hour >= now() - interval '30 days' GROUP BY 1) t),
    'sources_7d', (
      SELECT coalesce(json_agg(json_build_object(
          'source', s.source, 'visits', s.visits, 'sessions', s.sessions, 'plays', s.plays, 'likes', s.likes,
          'referrers', coalesce(r.referrers, '[]'::json),
          'landings', coalesce(l.landings, '[]'::json)
        ) ORDER BY s.visits DESC, s.sessions DESC), '[]'::json)
      FROM top_sources s
      LEFT JOIN referrer_json r USING (source)
      LEFT JOIN landing_json l USING (source)
    )
  );
$function$;

-- Replace the cached snapshot. The transaction advisory lock prevents an
-- overlapping cron run from computing the same seven-day aggregate twice.
CREATE OR REPLACE FUNCTION public.feed_stats_refresh()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result json;
  cached json;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('public.feed_stats')) THEN
    SELECT data::json INTO cached FROM feed_stats_cache WHERE singleton;
    IF FOUND THEN RETURN cached; END IF;
    RETURN feed_stats_compute();
  END IF;

  result := feed_stats_compute();
  INSERT INTO feed_stats_cache AS c (singleton, data, refreshed_at)
  VALUES (true, result::jsonb, now())
  ON CONFLICT (singleton) DO UPDATE
    SET data = EXCLUDED.data, refreshed_at = EXCLUDED.refreshed_at;
  RETURN result;
END $function$;

-- The public RPC only reads the snapshot, so repeated /stats/ polling and a
-- traffic spike cannot trigger overlapping seven-day scans.
CREATE OR REPLACE FUNCTION public.feed_stats()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cached json;
BEGIN
  SELECT data::json INTO cached FROM feed_stats_cache WHERE singleton;
  IF FOUND THEN RETURN cached; END IF;
  RETURN feed_stats_refresh();
END $function$;

REVOKE ALL ON FUNCTION public.feed_stats_compute() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feed_stats_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_stats() TO anon, authenticated;

-- Run after the cache table exists and the refresh function is deployed.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'feed-stats-refresh';
SELECT cron.schedule('feed-stats-refresh', '10 seconds', 'SELECT public.feed_stats_refresh()');
