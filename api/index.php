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

// TEMP DIAGNOSTICS — fast, non-booting network probe; remove after debugging.
if (($_GET['k'] ?? '') === 'pfdiag-9c1e' && isset($_GET['diag'])) {
    @set_time_limit(25);
    @ini_set('default_socket_timeout', '3');
    header('Content-Type: text/plain');
    $out = static function (string $line) {
        echo $line, "\n";
        @ob_flush();
        @flush();
    };
    $out('php '.PHP_VERSION.' max_execution_time='.ini_get('max_execution_time'));
    $out('task_root='.(getenv('LAMBDA_TASK_ROOT') ?: '(unset)').' cwd='.getcwd());
    $out('mysql/pgsql ext: pdo_pgsql='.(extension_loaded('pdo_pgsql') ? 'yes' : 'no'));

    $host = getenv('DB_HOST') ?: '';
    $port = (int) (getenv('DB_PORT') ?: 5432);
    $out("DB_HOST={$host} DB_PORT={$port} DB_PASSWORD_len=".strlen((string) getenv('DB_PASSWORD')));

    $t = microtime(true);
    $ips = @gethostbynamel($host);
    $out(sprintf('dns A: %s in %.2fs', $ips ? implode(',', $ips) : 'FAIL', microtime(true) - $t));

    foreach (array_slice(array_merge($ips ?: [], [$host]), 0, 3) as $target) {
        $t = microtime(true);
        $fp = @fsockopen($target, $port, $errno, $errstr, 3.0);
        $out(sprintf('tcp %s:%d -> %s in %.2fs %s', $target, $port, $fp ? 'OPEN' : 'FAIL', microtime(true) - $t, $fp ? '' : "({$errno} {$errstr})"));
        if ($fp) {
            fclose($fp);
        }
    }

    $t = microtime(true);
    try {
        $pdo = new PDO(
            "pgsql:host={$host};port={$port};dbname=".getenv('DB_DATABASE').';sslmode=require;connect_timeout=3',
            getenv('DB_USERNAME'),
            getenv('DB_PASSWORD'),
            [PDO::ATTR_TIMEOUT => 3, PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
        );
        $n = $pdo->query('select count(*) from information_schema.tables')->fetchColumn();
        $out(sprintf('pdo CONNECTED, tables=%s in %.2fs', $n, microtime(true) - $t));
    } catch (Throwable $e) {
        $out(sprintf('pdo FAIL in %.2fs: %s: %s', microtime(true) - $t, $e::class, $e->getMessage()));
    }
    $out('done');
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
