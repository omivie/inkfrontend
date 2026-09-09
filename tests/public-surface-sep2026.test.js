/**
 * The public surface of inkcartridges/ (ERR-229)
 * ==============================================
 *
 * `inkcartridges/vercel.json` sets `outputDirectory: "."` and the Vercel Root
 * Directory is `inkcartridges/`, so EVERY file in that tree is downloadable from
 * the live site. There is no `.vercelignore`, and there cannot usefully be one:
 * it filters the upload before the build runs, so excluding `scripts/` would
 * break `node scripts/stamp-versions.js`.
 *
 * That was not a hypothetical. Measured on production, Sep 2026:
 *
 *     GET /sql/analytics_function_grants.sql   200  application/x-sql  5714 B
 *     GET /sql/product_codes.sql               200  application/x-sql  8365 B
 *     GET /sql/admin_ui_prefs.sql              200
 *     GET /sql/order_tracking_requests.sql     200
 *     GET /sql/quote_uploads.sql               200
 *     GET /scripts/fit-audit.js                200
 *     GET /scripts/canonicalise-page-copy.mjs  200
 *
 * Anyone could read our full RLS policy set, our table shapes, the fact that
 * `authenticated` holds blanket insert+delete on `product_codes`, and — in the
 * analytics file — a step-by-step recipe for minting an `authenticated` JWT from
 * the anon key, sitting next to the note that the analytics RPCs are SECURITY
 * DEFINER.
 *
 * The rule was already written down. tests/colour-vocabulary-audit-aug2026.test.js
 * says "that tree is the Vercel project root and is served publicly … audit
 * tooling must not deploy", and three scripts in scripts/ repeat it in their
 * headers. Prose in a comment is not a control. Nothing enforced it, so `sql/`
 * was added to the served tree in Jul 2026 and nobody noticed for two months.
 *
 * This file is the enforcement. It fails the build if any non-web file appears
 * under inkcartridges/, and it exercises the middleware denylist that covers the
 * handful which genuinely cannot move.
 *
 * The live half is `npm run probe:public-surface` — this test proves the repo,
 * only the probe proves the deployment.
 *
 * Run with: node --test tests/public-surface-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const WEB_ROOT = path.join(ROOT, 'inkcartridges');

/** Extensions that legitimately belong on a static website. */
const WEB_EXTENSIONS = new Set([
  '.html', '.css', '.js', '.mjs', '.map', '.json', '.txt', '.xml', '.webmanifest',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pdf', '.mp4', '.webm',
]);

/**
 * Files inside the web root that are NOT part of the website but cannot move.
 *
 * Keep this list short and justify every entry. Anything addable here is
 * addable by someone in a hurry, so the reason has to survive being read by the
 * next person.
 */
const IMMOVABLE = new Map([
  ['scripts/stamp-versions.js', 'vercel.json buildCommand runs it; a .vercelignore would break the deploy'],
  ['serve.json', 'read by `npx serve inkcartridges` for local dev routing'],
  ['vercel.json', "Vercel's own config; must sit at the project root"],
  ['middleware.js', 'Vercel Edge Middleware; must sit at the project root'],
  ['package.json', 'nested build entrypoint — Vercel already excludes it from the output (measured 404)'],
]);

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.vercel') continue;
      walk(p, acc);
    } else {
      acc.push(p);
    }
  }
  return acc;
}

const rel = (p) => path.relative(WEB_ROOT, p).split(path.sep).join('/');

// ── §1. Nothing non-web may sit in the deployed tree ────────────────────────

test('§1 every file under inkcartridges/ is either a web asset or a listed exception', () => {
  const offenders = [];
  for (const file of walk(WEB_ROOT)) {
    const r = rel(file);
    if (IMMOVABLE.has(r)) continue;
    if (WEB_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    offenders.push(r);
  }
  assert.deepEqual(offenders, [],
    'these are published at https://www.inkcartridges.co.nz/<path> — move them to the repo root:\n  '
    + offenders.join('\n  '));
});

test('§1 no dot-directories in the web root — those are debris, never content', () => {
  // Found by dropping a `.csp-harness/` directory in there during ERR-230's
  // browser verification and noticing that nothing complained: its files were
  // .html and .js, so the extension allowlist above passed them. A dot-directory
  // is never intentional web content, and it would have deployed.
  const stray = fs.readdirSync(WEB_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('.') && e.name !== '.vercel')
    .map((e) => e.name);
  assert.deepEqual(stray, [], 'dot-directories under inkcartridges/ are published');
});

test('§1 THE BUG: no .sql anywhere under inkcartridges/', () => {
  // .sql is in neither list above, so §1 already covers it. Named separately
  // because this is the specific thing that leaked, and a failure message that
  // says "SQL is being served" is worth more than one that says "unknown
  // extension".
  const sql = walk(WEB_ROOT).filter((f) => f.toLowerCase().endsWith('.sql')).map(rel);
  assert.deepEqual(sql, [],
    'SQL files publish our RLS policies and grants to the internet; they live in repo-root sql/');
  assert.ok(!fs.existsSync(path.join(WEB_ROOT, 'sql')), 'inkcartridges/sql/ must not exist');
});

test('§1 the five SQL files still exist at the repo root — moved, not deleted', () => {
  // A green §1 is also what you get by deleting the files. Positive control.
  for (const f of ['analytics_function_grants.sql', 'product_codes.sql', 'admin_ui_prefs.sql',
                   'order_tracking_requests.sql', 'quote_uploads.sql']) {
    const p = path.join(ROOT, 'sql', f);
    assert.ok(fs.existsSync(p), `sql/${f} must exist at the repo root`);
    assert.ok(fs.statSync(p).size > 500, `sql/${f} looks truncated`);
  }
});

test('§1 the dev-only scripts moved out too, and the build script stayed', () => {
  for (const f of ['fit-audit.js', 'canonicalise-page-copy.mjs']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', f)), `scripts/${f} must be at the repo root`);
    assert.ok(!fs.existsSync(path.join(WEB_ROOT, 'scripts', f)), `${f} must not be in the deployed tree`);
  }
  assert.ok(fs.existsSync(path.join(WEB_ROOT, 'scripts', 'stamp-versions.js')),
    'stamp-versions.js must stay inside the Root Directory — buildCommand runs it from there');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['audit:fit'], 'node scripts/fit-audit.js',
    'the npm script must follow the file, or `npm run audit:fit` breaks');
});

// ── §2. The middleware denylist covers what could not move ─────────────────

test('§2 middleware returns a real 404 for every non-web path', async () => {
  const mw = await import(pathToFileURL(path.join(WEB_ROOT, 'middleware.js')).href);
  const req = (p) => new Request(`https://www.inkcartridges.co.nz${p}`);
  for (const p of ['/sql/product_codes.sql', '/sql/analytics_function_grants.sql',
                   '/scripts/stamp-versions.js', '/scripts/fit-audit.js',
                   '/serve.json', '/vercel.json', '/middleware.js']) {
    const res = await mw.default(req(p));
    assert.ok(res, `${p} fell through to static serving`);
    assert.equal(res.status, 404, `${p} must be 404, not ${res.status} — a redirect still confirms the path`);
  }
});

test('§2 the denylist paths are all in config.matcher, or the guard never runs', () => {
  // The guard is dead code for any path the matcher does not route to the edge.
  // This is the half that is easy to forget and impossible to see at runtime.
  const src = fs.readFileSync(path.join(WEB_ROOT, 'middleware.js'), 'utf8');
  for (const entry of ["'/sql/:path*'", "'/scripts/:path*'", "'/serve.json'",
                       "'/vercel.json'", "'/middleware.js'"]) {
    assert.ok(src.includes(entry), `config.matcher must contain ${entry}`);
  }
});

test('§2 the eleven original matcher entries survived', async () => {
  // Adding to this array is how you would accidentally remove from it.
  const mw = await import(pathToFileURL(path.join(WEB_ROOT, 'middleware.js')).href);
  for (const entry of ['/', '/admin/:path*', '/admin', '/products/:path*', '/product/:path*',
                       '/p/:path*', '/html/product', '/ribbons', '/ink-cartridges',
                       '/toner-cartridges', '/shop']) {
    assert.ok(mw.config.matcher.includes(entry), `matcher lost ${entry} — SEO prerender or admin gate breaks`);
  }
});

test('§2 the admin gate still redirects, and still lets a cookied request through', async () => {
  const mw = await import(pathToFileURL(path.join(WEB_ROOT, 'middleware.js')).href);
  const bare = await mw.default(new Request('https://www.inkcartridges.co.nz/admin'));
  assert.equal(bare.status, 302, 'uncookied /admin must still redirect to login');
  assert.match(bare.headers.get('location') || '', /\/account\/login/);

  const cookied = await mw.default(new Request('https://www.inkcartridges.co.nz/admin',
    { headers: { cookie: '__ink_auth=1' } }));
  assert.equal(cookied, undefined, 'a cookied /admin must fall through to the SPA, not 404');
});

// ── §2b. Every probe is actually reachable ────────────────────────────────

test('§2b every scripts/probe-*.mjs is registered as an npm script, and vice versa', () => {
  // probe:public-surface was written, committed, and then silently lost from
  // package.json when a concurrent session reconciled the same file. The script
  // file was still there; only the one line that made it runnable was gone, and
  // nothing failed — `npm run probe:public-surface` just said "Missing script".
  //
  // "Every probe is registered" is a list nobody maintains unless a test holds
  // it, which is the same lesson as the volume-pricing enrolment (ERR-150/160).
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const registered = new Set(
    Object.values(pkg.scripts || {})
      .map((cmd) => (cmd.match(/scripts\/([\w-]+\.mjs)/) || [])[1])
      .filter(Boolean)
  );
  const onDisk = fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((n) => n.startsWith('probe-') && n.endsWith('.mjs'));

  const unreachable = onDisk.filter((n) => !registered.has(n));
  assert.deepEqual(unreachable, [],
    'these probes exist but no npm script runs them, so nobody will:\n  ' + unreachable.join('\n  '));

  const missingFile = [...registered].filter((n) => !fs.existsSync(path.join(ROOT, 'scripts', n)));
  assert.deepEqual(missingFile, [],
    'these npm scripts point at a file that does not exist:\n  ' + missingFile.join('\n  '));
});

// ── §3. The rule is stated where someone would look for it ─────────────────

test('§3 the SQL that survived still documents why it is not in the web root', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'sql', 'analytics_function_grants.sql'), 'utf8');
  assert.match(sql, /inkcartridges/,
    'the header must say why this file is not under inkcartridges/, or it will drift back');
});
