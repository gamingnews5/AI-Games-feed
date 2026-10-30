# Database functions

- `feed_stats.sql` defines the cached aggregate RPC behind `/stats/`.
- `feed_stats_compute()` builds the seven-day snapshot.
- `feed_stats_refresh()` replaces the snapshot under an advisory lock.
- `feed_stats()` reads only `feed_stats_cache`, keeping requests below the `anon` role's 3-second `statement_timeout`.
- Keep the `pg_cron` job `feed-stats-refresh` running every 10 seconds.
- Apply on the Supabase host with `docker exec -i supabase-db psql -U postgres -d postgres < db/feed_stats.sql`.
- Check the snapshot with `SELECT * FROM feed_stats_cache;` after applying it.
- Run `curl` against `/rest/v1/rpc/feed_stats` with the public anon key after applying it.
