# AI Games Feed

TikTok-style vertical feed of **AI-made browser games** — Claude, ChatGPT/Astra, and more. Swipe through gameplay clips; open play links and sources from the card rail.

Live site: **[games.omgithub.com](https://games.omgithub.com/)**. **lolgames.net** serves the same build branded "LOL Games" (per-host config in `src/sites.js`).

Catalog source of truth: **[gamingnews5/Claude-vs-ChatGPT](https://github.com/gamingnews5/Claude-vs-ChatGPT)** (`data/grokgames.json`). At runtime the site reads it from **Cloudflare R2**, never from GitHub; this app does not ship the catalog.

## Preview

```bash
npm install
npm run serve
# → http://127.0.0.1:5173
```

## Sort & filters

Phone-friendly **Top | New** toggle in the top bar:

- **Top** — `screenshot_score` descending (default)
- **New** — newest first via `last_seen`, then `listed_at` / `first_seen`,
  `published_at`, `id`, `video_mtime`, and `remote_likes`

**Mobile** filter keeps games tagged for mobile/touch. Selection is stored in
`localStorage` (`opus-feed-sort`, `opus-feed-mobile-only`).

## Audio

Videos start muted on every page load (Instagram/TikTok-style). Unmuting lasts
only for the current session and resets on refresh.

## Catalog source (R2)

The site never fetches from GitHub at runtime. Flow:

1. Overheard (or any bot) commits `data/grokgames.json` (and media) to
   [gamingnews5/Claude-vs-ChatGPT](https://github.com/gamingnews5/Claude-vs-ChatGPT).
2. It then publishes to R2 (bucket `ai-games-videos`):

   ```bash
   /workspace/catalog-publish/publish_catalog.sh /workspace/Claude-vs-ChatGPT/data/grokgames.json
   ```

   The script validates the JSON (games array, minimum count, unique ids), uploads
   any repo-relative screenshots/clips/posters the catalog references that are not
   on R2 yet (same key as the repo path), then uploads the catalog to
   `catalog/grokgames.json` (`application/json`, `max-age=60`). `DRY_RUN=1` only checks.
3. The browser fetches same-origin **`/catalog.json`**. The Pages worker
   (`worker/index.js`) reads `catalog/grokgames.json` through the R2 bucket binding
   `CATALOG_BUCKET` (falls back to the public r2.dev URL) and edge-caches it for
   5 minutes, so a publish shows up within ~5–6 minutes.

Relative media (`video_path`, `videos[].path`, posters, screenshots) resolve to the
R2 public bucket under the same keys:

```
https://pub-f8a67dd028134c809667b629ac5ff178.r2.dev/videos/<file>.mp4
https://pub-f8a67dd028134c809667b629ac5ff178.r2.dev/screenshots/<file>.jpg
```

All sources live in **`src/catalog-config.js`** (`CATALOG_R2_KEY`, `MEDIA_BASE`,
`CATALOG_PUBLIC_URL`). Client mapping lives in `src/feed-from-catalog.js`
(platforms, authors, likes, comments, timestamps, `made_with` badges). In
`vite dev`, `/catalog.json` is proxied to the R2 public URL.

`public/games.json` is **not** the source of truth. Optional offline rebuild:
`npm run build:feed` / `npm run build:feed:offline` (air-gapped demos only).
Large twin video dirs (`public/videos/`, `public/videos-orig/`) are gitignored;
clips play from R2.

## Production build

```bash
npm run build
npm run preview
```

Static output is in `dist/`.

## Deploy (Cloudflare Pages, direct upload)

`games.omgithub.com` is the custom domain of the Cloudflare Pages project
**games-omgithub-feed** (<https://games-omgithub-feed.pages.dev>). It is a
direct-upload project: the site is built locally and `dist/` is uploaded. There
is no GitHub Actions deploy and the Pages project is not connected to GitHub.

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... scripts/deploy-cf-pages.sh
# = npm ci && npm run build, add 404.html/_redirects/_headers, then
#   npx wrangler pages deploy dist --project-name games-omgithub-feed --branch main
```

`_headers` keeps HTML no-cache and `/assets/*` immutable; `_redirects` sends
`/stats` to `/stats/`. The zone's HTML no-cache rules and the lolgames.net 301s
live in Cloudflare and are unchanged.

## Resume, seen, auto-advance

- **Last position** — `localStorage` key `opus-feed-last-id` (also `?g=`).
- **Seen set** — `opus-feed-seen`. Active card is marked seen.
- **Unseen catch-up** — on load/resume, unseen games that sort *above* the
  restored id are inserted immediately after the current card.
- **Sort toggle (Top/New)** — keeps the currently visible game id in the new
  order (instant land, no unseen catch-up). Mobile filter still jumps to top.
- **Auto-advance** — on video `ended`. Clips shorter than 10s loop until
  cumulative watch ≥ 10s, then advance; longer clips advance on first end.
- **End card** — “You're up to date” with a link to [omgithub.com](https://omgithub.com/).

## Likes, avatars & comments

- **Remote social proof** — `remote_likes` + `likes_source` (`x` | `github` | `reddit`).
- **Heart UI** — `remote_likes + (localLiked ? 1 : 0)`; local likes in `opus-feed-likes`.
- **Avatars** — prefer same-origin `/avatars/<user>.png`, else GitHub png, else initials.
- **Comments** — Overheard can attach a `comments` array; tap opens a bottom sheet.

## Related repos

| Repo | Role |
|------|------|
| [gamingnews5/Claude-vs-ChatGPT](https://github.com/gamingnews5/Claude-vs-ChatGPT) | Catalog + videos/screenshots (SoT; published to R2) |
| [gamingnews5/AI-Games-feed](https://github.com/gamingnews5/AI-Games-feed) | This feed UI (Cloudflare Pages project `games-omgithub-feed`) |

## License / contributions

Feed UI PRs welcome. New games belong in the **Claude-vs-ChatGPT** catalog via PR
(see that repo’s `CONTRIBUTING.md`).
