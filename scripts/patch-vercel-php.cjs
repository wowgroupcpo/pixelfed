#!/usr/bin/env node
/**
 * Build-time patch for the vercel-php runtime (runs as `buildCommand`).
 *
 * Why: since Vercel's Managed Images rollout (2026-08-10), the new
 * Rust/Node bootstrap can no longer load the AWS-style Lambda handler
 * `launcher.launcher` that vercel-php@0.9.0 emits, so EVERY function
 * invocation fails with FUNCTION_INVOCATION_FAILED
 * (ERR_MODULE_NOT_FOUND '/var/task/launcher.launcher') before any PHP
 * code runs. The upstream repo (vercel-community/php) is archived, so
 * the fix from its PR #654 will never reach npm. This script applies
 * that exact fix to the builder copy Vercel installed in the build
 * container, before the builder generates our function:
 *
 *   1. dist/index.js — construct a `NodejsLambda` instead of `Lambda`,
 *      with `handler: 'launcher.js'` and `awsLambdaHandler:
 *      'launcher.launcher'` (plus shouldAddHelpers/SourcemapSupport off).
 *   2. dist/launchers/helpers.js — fall back to '/var/task' when the new
 *      bootstrap does not set LAMBDA_TASK_ROOT, and normalise the
 *      API-Gateway-v1 event (byte-array body, host from headers) before
 *      it is proxied to PHP's built-in server.
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

/** Replace a top-level `function name(...) { ... }` block using brace matching. */
function replaceFunction(content, name, replacement, file) {
    const start = content.indexOf(`function ${name}(`);
    if (start === -1) {
        console.error(`${LOG} ERROR: function ${name} not found in ${file}`);
        process.exit(1);
    }
    let depth = 0;
    let end = -1;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = content.indexOf('{', start); i < content.length; i++) {
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

const NORMALIZE_EVENT = `function normalizeEvent(event) {
    // Patched by scripts/patch-vercel-php.cjs (upstream fix:
    // vercel-community/php#654). The current Vercel Node bootstrap may
    // deliver API Gateway v1-shaped events whose body is an array of
    // bytes and which carry no top-level host; normalise both before
    // the request is proxied to PHP's built-in server.
    let request = event;
    let isInvoke = false;
    if (event && event.Action === 'Invoke') {
        isInvoke = true;
        request = JSON.parse(event.body);
    }
    const method = isInvoke ? request.method : request.httpMethod;
    const path = request.path;
    const headers = request.headers || {};
    let host = request.host || '';
    if (!host) {
        const keys = Object.keys(headers);
        const hk = keys.find(k => k.toLowerCase() === 'x-forwarded-host')
            || keys.find(k => k.toLowerCase() === 'host');
        if (hk) {
            host = Array.isArray(headers[hk]) ? headers[hk][0] : headers[hk];
        }
    }
    let body = request.body;
    const encoding = isInvoke ? request.encoding : (request.isBase64Encoded === true ? 'base64' : 'utf8');
    if (body !== undefined && body !== null && !Buffer.isBuffer(body)) {
        if (Array.isArray(body)) {
            body = Buffer.from(body);
        }
        else if (typeof body === 'string') {
            body = Buffer.from(body, encoding === 'base64' ? 'base64' : 'utf8');
        }
    }
    return { method, path, host, headers, body };
}`;

function patchBuilderIndex(file) {
    let content = fs.readFileSync(file, 'utf8');
    if (content.includes("awsLambdaHandler: 'launcher.launcher'")) {
        console.log(`${LOG} ${file}: already patched, skipping`);
        return;
    }
    // Sanity: make sure the NodejsLambda class exists in the build-utils
    // copy this builder will resolve at build time.
    try {
        const buPath = require.resolve('@vercel/build-utils', { paths: [path.dirname(file)] });
        const bu = require(buPath);
        console.log(`${LOG} @vercel/build-utils resolved at ${buPath}; NodejsLambda available: ${typeof bu.NodejsLambda === 'function'}`);
    } catch (e) {
        console.log(`${LOG} WARNING: could not verify NodejsLambda availability (${e.message})`);
    }
    content = replaceOnce(content, 'const lambda = new build_utils_1.Lambda({', 'const lambda = new build_utils_1.NodejsLambda({', 'Lambda constructor', file);
    content = replaceOnce(
        content,
        "        handler: 'launcher.launcher',",
        "        handler: 'launcher.js',\n        awsLambdaHandler: 'launcher.launcher',\n        shouldAddHelpers: false,\n        shouldAddSourcemapSupport: false,",
        'handler config',
        file,
    );
    // Build-log marker: proves at build time whether this patched copy of
    // the builder is the one that actually executed (vs. an in-memory or
    // read-only copy loaded by the CLI before buildCommand ran).
    content = replaceOnce(
        content,
        '    return { output: lambda };',
        "    console.log('[patch-vercel-php] EMITTED file=' + __filename + ' handler=' + lambda.handler + ' launcherType=' + lambda.launcherType + ' awsLambdaHandler=' + lambda.awsLambdaHandler);\n    return { output: lambda };",
        'emitted-config marker',
        file,
    );
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
    if (content.includes('Patched by scripts/patch-vercel-php.cjs')) {
        console.log(`${LOG} ${file}: normalizeEvent already patched`);
    } else {
        content = replaceFunction(content, 'normalizeEvent', NORMALIZE_EVENT, file);
        changed = true;
    }
    if (changed) {
        writePatched(file, content);
    }
}

function main() {
    const roots = ['/vercel', process.cwd()];
    if (process.argv[2]) roots.unshift(process.argv[2]);

    let indexFiles = [];
    let helperFiles = [];
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        findFiles(root, path.join('vercel-php', 'dist', 'index.js'), 12, indexFiles);
        findFiles(root, path.join('vercel-php', 'dist', 'launchers', 'helpers.js'), 12, helperFiles);
    }
    indexFiles = [...new Set(indexFiles)];
    helperFiles = [...new Set(helperFiles)];

    if (indexFiles.length === 0) {
        console.warn(`${LOG} WARNING: vercel-php builder not found under ${roots.join(', ')} — nothing patched (function will keep failing until the builder is patchable)`);
        return;
    }
    for (const file of indexFiles) patchBuilderIndex(file);
    for (const file of helperFiles) patchHelpers(file);
    console.log(`${LOG} done`);
}

main();
