# Pixelfed on Vercel + Supabase (best-effort demo)

> ⚠️ **Read this first.** Pixelfed upstream is a Laravel 13 / PHP 8.5 app
> designed for a long-running server (Docker image with FrankenPHP,
> Horizon queue workers, scheduler, Redis, ffmpeg, libvips via FFI and
> persistent storage — see `Dockerfile` / `docker-compose.yml`).
> Vercel is serverless: **no background processes, 60s max function
> duration (Hobby), 4.5 MB request body limit, read-only filesystem
> except `/tmp`**. This deployment is therefore a **demo**, not a
> production Pixelfed instance.

## Live deployment (2026-11-13)

- **Production URL:** https://pixelfed-cpo16.vercel.app
  (deployment `dpl_GmE3zm5LvzhE42jdRubGS15uxsVL`, state READY/PROMOTED)
- **Vercel project:** `pixelfed` (`prj_CvtAwlk9ZTT5Ss5xxejPw35crMha`),
  team `cpo16`, connected to GitHub `wowgroupcpo/pixelfed`
- **Supabase project:** `pixelfed` (`xdvwzvcuyqqtnqirczyb`),
  `ap-southeast-1`, Postgres 17 — **271/271 migrations applied, 135 tables**
- First preview that completed migrations:
  `dpl_DHpNWZaZr4dhiD4qGPQt5P7MBd6v` (build ~13 min; later builds are
  fast because `migrate` becomes a no-op and the Composer cache hits)

> ⚠️ **Deployment Protection is ON** (team default: Vercel SSO for all
> `*.vercel.app` domains). Logged-in team members can open the site, but
> the public cannot. To make it public: Vercel dashboard → project
> `pixelfed` → **Settings → Deployment Protection → Vercel
> Authentication → Disabled** (Production), or attach a custom domain
> (custom domains are exempt from the team default).

Build gotchas already handled in this repo:

- Composer's default 300s process timeout kills long cross-region
  migrations → project env `COMPOSER_PROCESS_TIMEOUT=3600` is set.
- `VERCEL` is already set during builds, so `vercel-build.php` seeds
  `/tmp/pixelfed/storage` before running any `artisan` command.

## What was deployed

| Piece | Choice |
| --- | --- |
| Runtime | `vercel-php@0.9.0` (PHP 8.5, `pdo_pgsql`, `redis`, `bcmath`, `intl`) via `api/index.php` + `vercel.json` |
| Database | Supabase Postgres 17, project `pixelfed` (`ap-southeast-1`), transaction pooler `:6543` at runtime, session pooler `:5432` for build-time migrations |
| Cache / Session / Queue | `database` / `database` / `sync` (no Redis, no Horizon) |
| Storage | `/tmp/pixelfed/storage` (ephemeral, seeded from `storage/app` on cold start) |
| Scheduler / federation | Disabled (`ACTIVITY_PUB=false`), no cron, no Horizon |

## What does NOT work on Vercel

- Photo/video upload & processing (no libvips/GD/Imagick/ffmpeg in the
  runtime, plus the 4.5 MB body limit)
- Horizon queues, scheduled tasks, federation inbox/outbox delivery
- Anything needing persistent local files (media lives in `/tmp` and
  disappears on cold start) — use Supabase Storage (S3) for real media
- Realtime/broadcasting beyond the `log` driver

For a real instance use the included `Dockerfile` on a VPS / Fly.io /
Render / Railway with MySQL-or-Postgres + Redis, and keep Supabase as
the database if you like.

## Files added for Vercel (inert for Docker/VPS)

- `vercel.json` — function definition (`api/index.php`, 1024 MB, 60s), routes
- `api/index.php` — serverless entrypoint: seeds `/tmp` storage, serves
  `public/` statics, then boots `public/index.php`
- `api/php.ini` — memory/time/upload overrides for `vercel-php`
- `.vercelignore` — keeps `vendor/`, `node_modules/`, tests out of the upload
- `scripts/vercel-build.php` — run by the `vercel` Composer script during
  the Vercel build: `package:discover` + best-effort `migrate --force`
  against Supabase (failures are logged, never fail the deployment;
  redeploying resumes migrations)
- `bootstrap/app.php` — only change to upstream code: when `VERCEL` is
  set, `useStoragePath('/tmp/pixelfed/storage')`
- `.env.vercel.example` — the exact env var set used (placeholders)

## Redeploy / operate

1. Push to GitHub branch connected to the Vercel project, or trigger a
   deployment from the Vercel dashboard / connector.
2. Env vars live in Vercel Project Settings (see `.env.vercel.example`).
   `APP_KEY` and `DB_PASSWORD` are secrets — rotate them if leaked:
   the Supabase DB password can be reset in Supabase Project Settings.
3. Check the build log for `[vercel-build] artisan migrate` — if a
   migration failed on Postgres, fix it and redeploy to resume.
4. Create the first admin user: Pixelfed registers via the web UI
   (`OPEN_REGISTRATION=true` for the demo) — the first account can be
   promoted with `php artisan user:admin` on a real (Docker) install
   pointed at the same database.
