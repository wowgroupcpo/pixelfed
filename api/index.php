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

// TEMP DIAGNOSTICS — staged boot timing; remove after debugging.
if (($_GET['k'] ?? '') === 'pfdiag-7f3a' && isset($_GET['diag'])) {
    @set_time_limit(120);
    header('Content-Type: text/plain');
    $t0 = microtime(true);
    $stage = static function ($name) use ($t0) {
        echo sprintf("[%6.2fs] %s\n", microtime(true) - $t0, $name);
        @ob_flush();
        @flush();
    };
    $stage('plain php ok '.PHP_VERSION);
    try {
        $pdo = new PDO(
            'pgsql:host='.getenv('DB_HOST').';port='.getenv('DB_PORT').';dbname='.getenv('DB_DATABASE').';sslmode=require',
            getenv('DB_USERNAME'),
            getenv('DB_PASSWORD'),
            [PDO::ATTR_TIMEOUT => 10]
        );
        $stage('pdo connected');
        $n = $pdo->query('select count(*) from information_schema.tables')->fetchColumn();
        $stage("pdo query ok (tables=$n)");
        $pdo = null;
    } catch (Throwable $e) {
        $stage('pdo FAIL '.$e::class.': '.$e->getMessage());
    }
    try {
        require __DIR__.'/../vendor/autoload.php';
        $stage('autoload required');
        $app = require __DIR__.'/../bootstrap/app.php';
        $stage('app created');
        $kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
        $kernel->bootstrap();
        $stage('kernel bootstrapped');
    } catch (Throwable $e) {
        $stage('boot FAIL '.$e::class.': '.$e->getMessage().' @ '.$e->getFile().':'.$e->getLine());
    }
    $stage('done');
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
