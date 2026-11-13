#!/usr/bin/env node
/**
 * Build-time patch for the vercel-php runtime (runs as `buildCommand`).
 *
 * Why: vercel-php@0.9.0 still emits an AWS-Lambda-style handler
 * (`launcher.launcher`, i.e. `exports.launcher = async (event) => ...`).
 * Vercel's current Node runtime bootstrap cannot run that shape on its
 * Fluid compute path: the invocation hangs until the function timeout
 * and the runtime logs show
 *
 *   SyntaxError: Unexpected end of JSON input
 *       at JSON.parse (<anonymous>)
 *       at IncomingMessage.<anonymous> (/opt/rust/nodejs.js)
 *
 * which is exactly the failure Vercel staff confirmed for AWS-style
 * handlers on Fluid compute (and fixed by running those functions on the
 * Node runtime instead). The upstream repo (vercel-community/php) is
 * archived, so nothing will land on npm.
 *
 * The durable fix is therefore to stop using the AWS-style handler at
 * all and speak Vercel's supported web-standard protocol instead:
 *
 *   1. dist/launchers/launcher.js — replace the AWS-shaped launcher with
 *      `export default async function handler(request)` returning a
 *      `Response`. It boots PHP's built-in server on 127.0.0.1, proxies
 *      the Request to it and streams the Response back. Being an ES
 *      module with a default export, the runtime uses the web-standard
 *      path, and because the export is not named `launcher` it can no
 *      longer be mistaken for an AWS handler.
 *   2. dist/launchers/helpers.js — keep in step with the launcher: request
 *      target resolution (`/var/task` fallback) and a buffered-response
 *      helper instead of the AWS `statusCode/body` shape.
 *   3. dist/index.js — emit `handler: 'launcher.js'` with
 *      `shouldAddHelpers` off, and no `awsLambdaHandler` metadata so the
 *      runtime keeps using the web-standard entrypoint.
 *
 * The patch is idempotent and verifies every replacement. If the
 * builder cannot be found we only warn (deploy proceeds as before);
 * if it is found but a replacement fails we exit non-zero so the
 * build fails loudly instead of silently shipping a broken function.
 *
 * Refs: https://github.com/vercel-community/php/issues/650
 *       https://github.com/vercel-community/php/pull/654
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LOG = '[patch-vercel-php]';

function findFiles(root, suffix, maxDepth, out) {
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '.git') continue;
            if (maxDepth > 0) findFiles(full, suffix, maxDepth - 1, out);
        } else if (entry.isFile() && full.endsWith(suffix)) {
            out.push(full);
        }
    }
    return out;
}

function replaceOnce(content, from, to, label, file) {
    const count = content.split(from).length - 1;
    if (count !== 1) {
        console.error(`${LOG} ERROR: expected exactly 1 occurrence of ${label} in ${file}, found ${count}`);
        process.exit(1);
    }
    return content.replace(from, to);
}

/**
 * Replace a top-level `[async] function name(...) { ... }` block using brace
 * matching. The `async ` prefix is optional and deliberately not part of the
 * collapsed match, so both `function foo(` and `async function foo(` work.
 */
function replaceFunction(content, name, replacement, file) {
    const match = new RegExp(`(?:async )?function ${name}\\(`).exec(content);
    if (!match) {
        console.error(`${LOG} ERROR: function ${name} not found in ${file}`);
        process.exit(1);
    }
    const start = match.index;
    let depth = 0;
    let end = -1;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let inLineComment = false;
    let inBlockComment = false;
    // Skip the parameter list first: destructured parameters contain braces
    // of their own, and matching those would truncate the replacement.
    let paramsDepth = 0;
    let bodyStart = -1;
    for (let i = match.index + match[0].length - 1; i < content.length; i++) {
        if (content[i] === '(') paramsDepth++;
        else if (content[i] === ')') {
            paramsDepth--;
            if (paramsDepth === 0) {
                bodyStart = content.indexOf('{', i);
                break;
            }
        }
    }
    if (bodyStart === -1) {
        console.error(`${LOG} ERROR: could not find body of function ${name} in ${file}`);
        process.exit(1);
    }
    for (let i = bodyStart; i < content.length; i++) {
        const ch = content[i];
        const next = content[i + 1] || '';
        if (inLineComment) {
            if (ch === '\n') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && next === '/') { inBlockComment = false; i++; }
            continue;
        }
        if (inSingle) {
            if (ch === '\\') i++;
            else if (ch === "'") inSingle = false;
            continue;
        }
        if (inDouble) {
            if (ch === '\\') i++;
            else if (ch === '"') inDouble = false;
            continue;
        }
        if (inTemplate) {
            if (ch === '\\') i++;
            else if (ch === '`') inTemplate = false;
            continue;
        }
        if (ch === '/' && next === '/') { inLineComment = true; continue; }
        if (ch === '/' && next === '*') { inBlockComment = true; continue; }
        if (ch === "'") { inSingle = true; continue; }
        if (ch === '"') { inDouble = true; continue; }
        if (ch === '`') { inTemplate = true; continue; }
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) { end = i + 1; break; }
        }
    }
    if (end === -1) {
        console.error(`${LOG} ERROR: could not find end of function ${name} in ${file}`);
        process.exit(1);
    }
    return content.slice(0, start) + replacement + content.slice(end);
}

/**
 * Replaces the AWS-only `transformFromAwsRequest` with a request-target
 * helper for the web-standard launcher. `LAMBDA_TASK_ROOT` is not always
 * populated by the current bootstrap, so fall back to /var/task.
 */
const TRANSFORM_FROM_REQUEST = `function getRequestTarget(url) {
    // PATCHED_LAUNCHER
    const taskRoot = process.env.LAMBDA_TASK_ROOT || '/var/task';
    const userDir = (0, path_1.join)(taskRoot, 'user');
    const entrypoint = (0, path_1.join)(userDir, process.env.NOW_ENTRYPOINT || 'index.php');
    const parsed = new URL(url);
    return {
        entrypoint,
        path: parsed.pathname + parsed.search,
        host: parsed.host,
        url: parsed,
    };
}`;

/**
 * The launcher the runtime loads for `handler: 'launcher.js'`.
 *
 * Vercel's Node runtime only builds a web `Request` when it finds a named
 * `fetch` export (a default-exported function is invoked as the legacy
 * `(req, res)` pair and its return value is discarded, which is exactly the
 * hang/timeout being fixed here). So the handler is exported as
 * `export const fetch`, receives a `Request`, and returns a `Response`.
 *
 * PHP itself is unchanged: the built-in server is spawned on a local port
 * with the same document root/router/env as before, and requests are proxied
 * to it over loopback. The spawned server is cached for the lifetime of the
 * instance and reused across invocations.
 */
/** Drop the AWS response shim without leaving a dangling export. */
const TRANSFORM_TO_AWS_RESPONSE = `function transformToAwsResponse() {
    // PATCHED_LAUNCHER
    throw new Error('transformToAwsResponse is unused by the web-standard launcher');
}`;

const LAUNCHER_VERSION = 'web-standard-cjs-1';

const LAUNCHER_MODULE = `// Generated by scripts/patch-vercel-php.cjs for Vercel's Node runtime.
// PATCHED_LAUNCHER: web-standard-cjs-1
// Replaces the stock AWS-style launcher with a web-standard
// (Request -> Response) handler.
//
// CommonJS on purpose: the function directory has no package.json with
// "type": "module", so an .js file using import/export would be parsed as
// CommonJS and crash at load time. Assigning to \`exports.fetch\` still lets
// an ESM importer pick up the named export (Node's CJS lexer detects it).
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const net = require('net');
const { join } = require('path');
const { getPhpDir, getUserDir, isDev } = require('./helpers.js');

let server = null;
let starting = null;

const PORT = Number(process.env.VERCEL_PHP_PORT || 3000);

async function whenPortOpens(port, attempts) {
    return new Promise((resolve, reject) => {
        const attempt = (left) => {
            const client = net.connect(port, '127.0.0.1');
            client.on('error', (error) => {
                if (!left) return reject(error);
                setTimeout(() => attempt(left - 1), 10);
            });
            client.on('connect', () => {
                client.destroy();
                resolve();
            });
        };
        attempt(attempts);
    });
}

function startServer() {
    if (server) return Promise.resolve(server);
    if (starting) return starting;

    starting = (async () => {
        const router = join(getUserDir(), process.env.NOW_ENTRYPOINT || 'index.php');
        const docroot = join(getUserDir(), process.env.VERCEL_PHP_DOCROOT ?? '');
        console.log('🐘 Spawning: PHP Built-In Server at ' + docroot + ' (document root) and ' + router + ' (router)');

        const options = {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                LD_LIBRARY_PATH: '/var/task/lib:' + (process.env.LD_LIBRARY_PATH || ''),
            },
        };
        if (!isDev()) {
            options.env.PATH = getPhpDir() + ':' + (process.env.PATH || '');
            options.cwd = getPhpDir();
        } else {
            options.cwd = getUserDir();
        }

        server = spawn('php', ['-c', 'php.ini', '-S', '127.0.0.1:' + PORT, '-t', docroot, router], options);
        server.stdout?.on('data', (data) => console.log('🐘STDOUT: ' + data.toString()));
        server.stderr?.on('data', (data) => console.error('🐘STDERR: ' + data.toString()));
        server.on('close', (code, signal) => {
            console.log('🐘 PHP Built-In Server process closed code ' + code + ' and signal ' + signal);
            server = null;
            starting = null;
        });
        server.on('error', (err) => {
            console.error('🐘 PHP Built-In Server process errored ' + err);
        });

        await whenPortOpens(PORT, 500);
        return server;
    })();

    return starting;
}

function proxy(request, body) {
    const url = new URL(request.url);
    const headers = {};
    for (const [key, value] of request.headers) {
        headers[key] = value;
    }
    // The built-in server expects an absolute URI so Laravel can rebuild the
    // original scheme/host; the platform terminates TLS before the function.
    headers.host = headers.host || url.host;
    headers['x-forwarded-host'] = headers['x-forwarded-host'] || url.host;
    headers['x-forwarded-proto'] = headers['x-forwarded-proto'] || url.protocol.replace(':', '');
    if (body.length) {
        headers['content-length'] = String(body.length);
    }

    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port: PORT,
                path: url.pathname + url.search,
                method: request.method,
                headers,
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const responseHeaders = new Headers();
                    for (const [key, value] of Object.entries(res.headers)) {
                        if (value === undefined) continue;
                        if (Array.isArray(value)) {
                            for (const item of value) responseHeaders.append(key, item);
                        } else {
                            responseHeaders.set(key, value);
                        }
                    }
                    const status = res.statusCode || 200;
                    const emptyBody = status === 204 || status === 304;
                    resolve(
                        new Response(emptyBody ? null : Buffer.concat(chunks), {
                            status,
                            headers: responseHeaders,
                        }),
                    );
                });
                res.on('error', reject);
            },
        );
        req.on('error', (error) => {
            console.error('🐘 PHP Built-In Server HTTP errored ' + error);
            resolve(
                new Response('PHP Built-In Server HTTP error: ' + error, {
                    status: 500,
                    headers: { 'content-type': 'text/plain; charset=utf-8' },
                }),
            );
        });
        if (body.length) req.write(body);
        req.end();
    });
}

async function fetchHandler(request) {
    await startServer();
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);
    console.log('🐘 ' + request.method + ' ' + new URL(request.url).pathname);
    return proxy(request, body);
}

// Named export the runtime looks for to treat this as a web-standard handler.
exports.fetch = fetchHandler;
// Also reachable as default.fetch for runtimes that unwrap default instead.
exports.default = { fetch: fetchHandler };
`;
function patchBuilderIndex(file) {
    let content = fs.readFileSync(file, 'utf8');
    const original = content;

    // 1. NodejsLambda instead of the generic AWS Lambda class, so the
    //    Node launcher metadata is what gets written to .vc-config.json.
    if (content.includes('new build_utils_1.NodejsLambda({')) {
        console.log(`${LOG} ${file}: NodejsLambda already in use`);
    } else {
        try {
            const buPath = require.resolve('@vercel/build-utils', { paths: [path.dirname(file)] });
            const bu = require(buPath);
            console.log(`${LOG} @vercel/build-utils resolved at ${buPath}; NodejsLambda available: ${typeof bu.NodejsLambda === 'function'}`);
        } catch (e) {
            console.log(`${LOG} WARNING: could not verify NodejsLambda availability (${e.message})`);
        }
        content = replaceOnce(
            content,
            'const lambda = new build_utils_1.Lambda({',
            'const lambda = new build_utils_1.NodejsLambda({',
            'Lambda constructor',
            file,
        );
    }

    // 2. Web-standard entrypoint: the launcher is an ES module with a
    //    default export, so no awsLambdaHandler metadata may be set —
    //    that flag is precisely what routes invocations through the
    //    AWS-shaped bridge that hangs on Fluid compute.
    if (content.includes("handler: 'launcher.js',\n        shouldAddHelpers: false")) {
        console.log(`${LOG} ${file}: handler config already patched`);
    } else if (content.includes("awsLambdaHandler: 'launcher.launcher'")) {
        // Undo the older AWS-compat variant of this patch.
        content = replaceOnce(
            content,
            "        handler: 'launcher.js',\n        awsLambdaHandler: 'launcher.launcher',\n        shouldAddHelpers: false,\n        shouldAddSourcemapSupport: false,",
            "        handler: 'launcher.js',\n        shouldAddHelpers: false,\n        shouldAddSourcemapSupport: false,",
            'legacy awsLambdaHandler removal',
            file,
        );
    } else {
        content = replaceOnce(
            content,
            "        handler: 'launcher.launcher',",
            "        handler: 'launcher.js',\n        shouldAddHelpers: false,\n        shouldAddSourcemapSupport: false,",
            'handler config',
            file,
        );
    }

    // 3. Build-log marker: proves at build time which builder copy emitted
    //    the function, and what metadata it emitted.
    if (content.includes('[patch-vercel-php] EMITTED')) {
        console.log(`${LOG} ${file}: emitted marker already present`);
    } else {
        content = replaceOnce(
            content,
            '    return { output: lambda };',
            "    console.log('[patch-vercel-php] EMITTED file=' + __filename + ' handler=' + lambda.handler + ' launcherType=' + lambda.launcherType + ' awsLambdaHandler=' + lambda.awsLambdaHandler);\n    return { output: lambda };",
            'emitted-config marker',
            file,
        );
    }

    if (content === original) {
        return;
    }
    writePatched(file, content);
}

function writePatched(file, content) {
    try {
        fs.writeFileSync(file, content);
        console.log(`${LOG} patched ${file}`);
    } catch (e) {
        if (e.code === 'EROFS' || e.code === 'EACCES' || e.code === 'EPERM') {
            // Builders are also mounted read-only (squashfs) in the build
            // container; only the writable working copy can be patched.
            console.log(`${LOG} skipping read-only copy ${file} (${e.code})`);
            return;
        }
        throw e;
    }
}

function patchHelpers(file) {
    let content = fs.readFileSync(file, 'utf8');
    let changed = false;
    if (content.includes("LAMBDA_TASK_ROOT || '/var/task'")) {
        console.log(`${LOG} ${file}: task-root fallback already patched`);
    } else {
        const before = content.split("process.env.LAMBDA_TASK_ROOT || '/'").length - 1;
        if (before !== 2) {
            console.error(`${LOG} ERROR: expected 2 LAMBDA_TASK_ROOT fallbacks in ${file}, found ${before}`);
            process.exit(1);
        }
        content = content.split("process.env.LAMBDA_TASK_ROOT || '/'").join("process.env.LAMBDA_TASK_ROOT || '/var/task'");
        changed = true;
    }
    if (content.includes('getRequestTarget') && content.includes('getRequestTarget = getRequestTarget')) {
        console.log(`${LOG} ${file}: request-target helper already patched`);
    } else {
        content = replaceFunction(content, 'transformFromAwsRequest', TRANSFORM_FROM_REQUEST, file);
        // The CommonJS re-export list at the top of the file still points at
        // the removed function; leaving it behind crashes the module at load
        // time (ReferenceError) before any request is served.
        content = replaceOnce(
            content,
            'exports.transformFromAwsRequest = transformFromAwsRequest;',
            'exports.getRequestTarget = getRequestTarget;',
            'helpers re-export list',
            file,
        );
        content = replaceOnce(
            content,
            'exports.transformToAwsResponse = transformToAwsResponse;\n',
            '',
            'AWS response re-export',
            file,
        );
        content = replaceFunction(content, 'transformToAwsResponse', TRANSFORM_TO_AWS_RESPONSE, file);
        changed = true;
    }
    if (changed) {
        writePatched(file, content);
    }
}

/**
 * Replace the AWS-shaped launcher (`exports.launcher`) with a web-standard
 * handler that the Node runtime picks up via `export const fetch`.
 * The PHP side is untouched: it is still PHP's built-in server behind a
 * local socket, only the transport binding changes.
 */
function patchLauncher(file) {
    let content = fs.readFileSync(file, 'utf8');
    const marker = `PATCHED_LAUNCHER: ${LAUNCHER_VERSION}`;
    if (content.includes(marker)) {
        console.log(`${LOG} ${file}: launcher already at ${LAUNCHER_VERSION}`);
        return;
    }
    // Full-file replacement: everything in the stock builtin.js is tied to
    // the AWS handler protocol, so nothing is worth preserving verbatim.
    writePatched(file, LAUNCHER_MODULE);
}

function main() {
    const roots = ['/vercel', process.cwd()];
    if (process.argv[2]) roots.unshift(process.argv[2]);

    let indexFiles = [];
    let helperFiles = [];
    let launcherFiles = [];
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        findFiles(root, path.join('vercel-php', 'dist', 'index.js'), 12, indexFiles);
        findFiles(root, path.join('vercel-php', 'dist', 'launchers', 'helpers.js'), 12, helperFiles);
        findFiles(root, path.join('vercel-php', 'dist', 'launchers', 'builtin.js'), 12, launcherFiles);
    }
    indexFiles = [...new Set(indexFiles)];
    helperFiles = [...new Set(helperFiles)];
    launcherFiles = [...new Set(launcherFiles)];

    if (indexFiles.length === 0) {
        console.warn(`${LOG} WARNING: vercel-php builder not found under ${roots.join(', ')} — nothing patched (function will keep failing until the builder is patchable)`);
        return;
    }
    for (const file of indexFiles) patchBuilderIndex(file);
    for (const file of helperFiles) patchHelpers(file);
    for (const file of launcherFiles) patchLauncher(file);
    console.log(`${LOG} done`);
}

main();
