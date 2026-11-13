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

// TEMP DIAGNOSTICS — DB reachability + Laravel boot; remove after debugging.
if (($_GET['k'] ?? '') === 'pfdiag-db') {
    header('Content-Type: text/plain');
    @set_time_limit(25);
    echo "DB_HOST=", getenv('DB_HOST'), " DB_PORT=", getenv('DB_PORT'), " DB=", getenv('DB_DATABASE'), "\n";
    echo "cache=", getenv('CACHE_STORE'), " session=", getenv('SESSION_DRIVER'), "\n";
    $t = microtime(true);
    try {
        $pdo = new PDO(
            'pgsql:host='.getenv('DB_HOST').';port='.getenv('DB_PORT').';dbname='.getenv('DB_DATABASE').';sslmode=require;connect_timeout=8',
            getenv('DB_USERNAME'),
            getenv('DB_PASSWORD'),
            [PDO::ATTR_TIMEOUT => 8, PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
        );
        printf("pdo ok in %.2fs, tables=%s\n", microtime(true) - $t, $pdo->query('select count(*) from information_schema.tables')->fetchColumn());
        $pdo = null;
    } catch (Throwable $e) {
        printf("pdo FAIL in %.2fs: %s\n", microtime(true) - $t, $e->getMessage());
    }
    try {
        require __DIR__.'/../vendor/autoload.php';
        $app = require __DIR__.'/../bootstrap/app.php';
        $k = $app->make(Illuminate\Contracts\Http\Kernel::class);
        $k->bootstrap();
        echo "laravel booted\n";
        try {
            $req = Illuminate\Http\Request::create('/api/v1/instance', 'GET');
            $res = $k->handle($req);
            echo "instance status=", $res->getStatusCode(), "\n";
            echo substr((string) $res->getContent(), 0, 300), "\n";
        } catch (Throwable $e) {
            echo "handle FAIL ", $e::class, ': ', $e->getMessage(), "\n";
        }
    } catch (Throwable $e) {
        echo "boot FAIL ", $e::class, ': ', $e->getMessage(), "\n";
    }
    exit;
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
