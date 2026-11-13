<?php

/**
 * Pixelfed — Vercel serverless entrypoint (best-effort demo).
 *
 * Vercel has no persistent filesystem (only /tmp is writable) and no
 * long-running processes, so before Laravel boots we mirror the
 * `storage/app` seed data into /tmp. bootstrap/app.php points Laravel's
 * storage path at the same /tmp location when the VERCEL env is present.
 *
 * Static files that ship in public/ are served directly by PHP's built-in
 * server (this file acts as its router): returning false lets the server
 * serve the requested file from the public/ document root
 * (see VERCEL_PHP_DOCROOT in vercel.json).
 */

$serverlessStorage = '/tmp/pixelfed/storage';

// Every directory is created independently: gating the whole block on one of
// them meant a warm /tmp that happened to be missing app/public was never
// repaired, and every /storage/ URL 404'd for the life of the instance.
foreach ([
    '/app/public',
    '/framework/cache/data',
    '/framework/sessions',
    '/framework/views',
    '/logs',
] as $dir) {
    if (! is_dir($serverlessStorage.$dir)) {
        @mkdir($serverlessStorage.$dir, 0775, true);
    }
}

// Seed /tmp storage with the app data that ships in git
// (cities.json, default avatars/headers, bouncer rules, ...). Each file is
// checked on its own so a partial copy is completed on the next request.
$seedFrom = __DIR__.'/../storage/app';
// getSubPathname() has no leading separator, so this MUST end with one --
// without it every file landed in storage/apppublic/ and /storage/* 404'd.
$seedTo = rtrim($serverlessStorage, '/').'/app/';
if (is_dir($seedFrom)) {
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($seedFrom, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST
    );
    foreach ($iterator as $item) {
        $target = $seedTo.$iterator->getSubPathname();
        if ($item->isDir()) {
            if (! is_dir($target)) {
                @mkdir($target, 0775, true);
            }
        } elseif (! file_exists($target)) {
            @copy($item->getPathname(), $target);
        }
    }
}

$uri = urldecode(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/');

if (str_starts_with($uri, '/storage/')) {
    $mediaFile = $serverlessStorage.'/app/public/'.substr($uri, strlen('/storage/'));
    if (is_file($mediaFile)) {
        // No getimagesize/mime_content_type here: those need extensions this
        // demo does not always load, and the media set is small and known.
        $ext = strtolower(pathinfo($mediaFile, PATHINFO_EXTENSION));
        $mime = [
            'jpg' => 'image/jpeg',
            'jpeg' => 'image/jpeg',
            'png' => 'image/png',
            'gif' => 'image/gif',
            'webp' => 'image/webp',
            'svg' => 'image/svg+xml',
            'mp4' => 'video/mp4',
            'json' => 'application/json',
        ][$ext] ?? 'application/octet-stream';
        header('Content-Type: '.$mime);
        header('Content-Length: '.filesize($mediaFile));
        header('Cache-Control: public, max-age=31536000');
        echo file_get_contents($mediaFile);

        return;
    }
}

$staticFile = __DIR__.'/../public'.$uri;

// Never let PHP's built-in server (or Vercel's filesystem layer) serve a
// .php file as a static download — that leaks Laravel's front controller
// source instead of executing it. Only real static assets return false.
if ($uri !== '/' && is_file($staticFile) && ! str_ends_with(strtolower($uri), '.php')) {
    return false;
}

require __DIR__.'/../public/index.php';
