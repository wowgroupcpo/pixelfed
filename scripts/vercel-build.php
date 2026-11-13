<?php

/**
 * Pixelfed — Vercel build-time helper.
 *
 * Invoked by the `vercel` Composer script, which the vercel-php builder
 * runs automatically right after `composer install --no-dev --no-scripts`.
 *
 * It best-effort migrates the Supabase Postgres database. A migration
 * failure must NOT fail the whole deployment (Pixelfed upstream targets
 * MySQL; a few of its 271 migrations may need manual attention on
 * Postgres), so every failure is reported in the build log and the
 * script still exits 0. Re-running a deployment resumes migrations
 * from the last successful one.
 */

$root = dirname(__DIR__);

function vercel_build_run(string $command, string $label): int
{
    echo "\n[vercel-build] {$label}\n[vercel-build] \$ {$command}\n";
    passthru($command, $exitCode);
    echo "[vercel-build] {$label} finished with exit code {$exitCode}\n";

    return $exitCode;
}

// 1. Package discovery was skipped by the builder's --no-scripts install;
//    Laravel needs the manifest in bootstrap/cache to boot.
vercel_build_run(
    'php '.escapeshellarg($root.'/artisan').' package:discover --ansi 2>&1',
    'artisan package:discover'
);

// 2. Migrate Supabase (session pooler on port 5432 when provided —
//    transaction pooler on 6543 can break DDL migrations).
if (getenv('DB_HOST')) {
    $overrides = [];
    foreach (['DB_HOST', 'DB_PORT', 'DB_USERNAME'] as $key) {
        $value = getenv('VERCEL_MIGRATE_'.$key);
        if ($value !== false && $value !== '') {
            $overrides[] = $key.'='.escapeshellarg($value);
        }
    }

    $prefix = $overrides ? implode(' ', $overrides).' ' : '';
    $code = vercel_build_run(
        $prefix.'php '.escapeshellarg($root.'/artisan').' migrate --force --no-interaction 2>&1',
        'artisan migrate (Supabase Postgres)'
    );

    if ($code !== 0) {
        echo "[vercel-build] WARNING: migrations did not complete. "
            ."The deployment will continue; check the log above, fix the "
            ."failing migration, and redeploy to resume migrating.\n";
    }
} else {
    echo "[vercel-build] DB_HOST is not set — skipping migrations.\n";
}

exit(0);
