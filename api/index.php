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

// TEMP DIAGNOSTICS — dump what the launcher forwarded; remove after debugging.
if (($_GET['k'] ?? '') === 'pfdiag-req') {
    header('Content-Type: text/plain');
    echo "REQUEST_URI=", $_SERVER['REQUEST_URI'] ?? '', "\n";
    echo "SCRIPT_NAME=", $_SERVER['SCRIPT_NAME'] ?? '', "\n";
    echo "HTTP_HOST=", $_SERVER['HTTP_HOST'] ?? '', "\n";
    echo "X_FORWARDED_HOST=", $_SERVER['HTTP_X_FORWARDED_HOST'] ?? '', "\n";
    echo "X_FORWARDED_PROTO=", $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '', "\n";
    foreach ($_SERVER as $k => $v) {
        if (str_starts_with($k, 'HTTP_X_') && is_string($v)) {
            echo $k, '=', substr($v, 0, 200), "\n";
        }
    }
    exit;
}

$serverlessStorage = '/tmp/pixelfed/storage';

if (! is_dir($serverlessStorage.'/framework/views')) {
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
    // (cities.json, default avatars/headers, bouncer rules, ...).
    $seedFrom = __DIR__.'/../storage/app';
    $seedTo = $serverlessStorage.'/app';
    if (is_dir($seedFrom) && ! file_exists($seedTo.'/cities.json')) {
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
}

$uri = urldecode(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/');
$staticFile = __DIR__.'/../public'.$uri;

// Never let PHP's built-in server (or Vercel's filesystem layer) serve a
// .php file as a static download — that leaks Laravel's front controller
// source instead of executing it. Only real static assets return false.
if ($uri !== '/' && is_file($staticFile) && ! str_ends_with(strtolower($uri), '.php')) {
    return false;
}

require __DIR__.'/../public/index.php';
