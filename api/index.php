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

// TEMP DIAGNOSTICS — remove after debugging the Vercel 500.
if (($_GET['k'] ?? '') === 'pfdiag-7f3a') {
    header('Content-Type: text/plain');
    if (isset($_GET['diag'])) {
        echo "php=".PHP_VERSION." sapi=".PHP_SAPI."\n";
        echo 'autoload='.(file_exists(__DIR__.'/../vendor/autoload.php') ? 'yes' : 'no')."\n";
        foreach (['pdo_pgsql', 'gd', 'redis', 'intl', 'mbstring'] as $ext) {
            echo "ext_$ext=".(extension_loaded($ext) ? 'yes' : 'no')."\n";
        }
        echo 'APP_KEY='.(getenv('APP_KEY') ? 'set' : 'MISSING')."\n";
        echo 'DB_HOST='.getenv('DB_HOST').' DB_PORT='.getenv('DB_PORT')."\n";
        echo 'tmp_writable='.(is_writable('/tmp') ? 'yes' : 'no')."\n";
        $t = microtime(true);
        try {
            $pdo = new PDO(
                'pgsql:host='.getenv('DB_HOST').';port='.getenv('DB_PORT').';dbname='.getenv('DB_DATABASE').';sslmode=require',
                getenv('DB_USERNAME'),
                getenv('DB_PASSWORD'),
                [PDO::ATTR_TIMEOUT => 10]
            );
            echo sprintf("db_connect=OK in %.2fs\n", microtime(true) - $t);
            $pdo = null;
        } catch (Throwable $e) {
            echo sprintf("db_connect=FAIL in %.2fs %s: %s\n", microtime(true) - $t, $e::class, $e->getMessage());
        }
        exit;
    }
    ini_set('display_errors', '1');
    error_reporting(E_ALL);
    register_shutdown_function(static function () {
        $err = error_get_last();
        if ($err) {
            echo "\n[shutdown] {$err['type']}: {$err['message']} in {$err['file']}:{$err['line']}\n";
        }
    });
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
