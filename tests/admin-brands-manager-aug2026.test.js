/**
 * Brands manager — the surface that makes the /shop grid editable
 * ===============================================================
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 *
 * /shop used to decide which brands rendered a tile by filtering `/api/brands`
 * against a hardcoded ten-slug array inside `renderBrands()`. A brand present in
 * the database but absent from that array rendered NO TILE, with no error
 * anywhere; seventeen live brands were in that state.
 *
 * The backend replaced it with `brands.show_on_shop` + `sort_order` and — without
 * mentioning it in the handover — also shipped POST/PUT/DELETE /api/admin/brands.
 * Without this page those columns are reachable only by hand-written SQL, i.e. the
 * hardcoded list would simply have moved into a database column nobody in the
 * admin can edit.
 *
 * ── The two hazards pinned here ─────────────────────────────────────────────
 *
 * 1. The API SILENTLY STRIPS unknown keys instead of rejecting them (measured).
 *    A misspelled field returns 200 and changes nothing — "it appeared to work
 *    and did nothing", which is the failure this whole area exists to clean up.
 *    So every write is read back and compared, and `brandEchoMissing` is what
 *    does the comparing. It MEASURES rather than assumes, so it reports nothing
 *    once the backend agrees (same shape as refEchoMissing, ERR-182/BF-051).
 *
 * 2. `/api/brands` is Cloudflare edge-cached AND client-SWR-cached. Measured:
 *    a brand created through the API did NOT appear in an edge-served
 *    /api/brands for minutes. An editor that reads through those caches shows
 *    the operator a list without the row they just wrote.
 *
 * Run with: node --test tests/admin-brands-manager-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(p, 'utf8');

const brandsJs = read(path.join(SITE, 'js', 'admin', 'pages', 'brands.js'));
const adminApiJs = read(path.join(SITE, 'js', 'admin', 'api.js'));
const browseJs = read(path.join(SITE, 'js', 'admin', 'pages', 'catalogue-browse.js'));
const adminCss = read(path.join(SITE, 'css', 'admin.css'));

/**
 * brands.js imports ../app.js, which is browser-only, so pull the two pure
 * functions out and evaluate them in isolation. Same idiom as
 * tests/admin-product-save-may2026.test.js's loadFn.
 */
function loadPureFns() {
  const grab = (sig) => {
    const i = brandsJs.indexOf(sig);
    assert.notEqual(i, -1, `not found: ${sig}`);
    let depth = 0, j = brandsJs.indexOf('{', i);
    for (; j < brandsJs.length; j++) {
      if (brandsJs[j] === '{') depth++;
      else if (brandsJs[j] === '}') { depth--; if (depth === 0) break; }
    }
    return brandsJs.slice(i, j + 1).replace(/^export\s+/, '');
  };
  const src = `${grab('export function brandEchoMissing')}\n${grab('export function slugifyBrand')}`;
  return vm.runInNewContext(`${src}; ({ brandEchoMissing, slugifyBrand })`);
}

const F = loadPureFns();

/**
 * `brandEchoMissing` runs inside a vm realm, so the array it returns carries THAT
 * realm's Array.prototype — and `deepStrictEqual` compares prototypes, so two
 * identical lists fail with a printed diff that looks the same on both sides.
 * Array.from() re-homes it. (Cost about ten minutes once already, ERR-187.)
 */
const echo = (sent, echoed) => Array.from(F.brandEchoMissing(sent, echoed));

// ─────────────────────────────────────────────────────────────────────────────
// 1. The echo check — the answer to "it returned 200 but did it store anything?"
// ─────────────────────────────────────────────────────────────────────────────

test('a field the API silently strips is reported BY NAME', () => {
  // The measured behaviour: unknown keys vanish and the call still returns 200.
  const sent = { show_on_shop: true, zzz_not_a_column: 'x' };
  const echoed = { show_on_shop: true };
  assert.deepEqual(echo(sent, echoed), ['zzz_not_a_column'],
    'a stripped field must be named — a silent 200 is exactly the bug being guarded');
});

test('a field that DID store reports nothing — the check self-heals', () => {
  // A warning that cannot go away becomes noise and then gets ignored. This one
  // measures the echo, so it disappears the moment the backend agrees.
  const sent = { show_on_shop: false, sort_order: 7, logo_url: 'https://x/y.png' };
  assert.deepEqual(echo(sent, { ...sent, id: 'b1', name: 'X' }), [],
    'an echo that matches must produce no warning at all');
});

test('a value the API legitimately normalises is not reported as lost', () => {
  // Whitespace and string/number coercion are normalisation, not disagreement.
  assert.deepEqual(echo({ name: ' Ricoh ' }, { name: 'Ricoh' }), []);
  assert.deepEqual(echo({ logo_url: null }, { logo_url: '' }), []);
});

test('booleans and numbers are compared strictly — false must not read as stored-true', () => {
  assert.deepEqual(echo({ show_on_shop: false }, { show_on_shop: true }), ['show_on_shop'],
    'the toggle is the whole feature; a wrong echo here must never pass');
  assert.deepEqual(echo({ sort_order: 3 }, { sort_order: 9 }), ['sort_order']);
});

test('an unreadable echo reports nothing rather than inventing failures', () => {
  assert.deepEqual(echo({ a: 1 }, null), []);
  assert.deepEqual(echo(null, { a: 1 }), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Slug derivation — it becomes part of every /shop URL for that brand.
// ─────────────────────────────────────────────────────────────────────────────

test('slugifyBrand matches the live slug convention', () => {
  assert.equal(F.slugifyBrand('Fuji Xerox'), 'fuji-xerox', 'matches the live fuji-xerox row');
  assert.equal(F.slugifyBrand('HP'), 'hp');
  assert.equal(F.slugifyBrand('  Triumph-Adler  '), 'triumph-adler');
  assert.equal(F.slugifyBrand('Ricoh!!'), 'ricoh', 'punctuation must not reach a URL');
  assert.equal(F.slugifyBrand(''), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The write path uses the verbs that exist, and checks its envelopes.
// ─────────────────────────────────────────────────────────────────────────────

test('brand writes use PUT — PATCH does not exist on this API', () => {
  const i = adminApiJs.indexOf('async updateBrand(');
  assert.notEqual(i, -1, 'updateBrand must exist');
  const body = adminApiJs.slice(i, i + 400);
  assert.match(body, /window\.API\.put\(/, 'measured: PATCH /api/admin/brands/:id returns 404');
  assert.doesNotMatch(body, /window\.API\.patch\(/);
});

test('every brand write checks resp.ok === false', () => {
  // The deleteProduct lesson: API.request() RESOLVES on failure envelopes, so a
  // helper without this check reports success on every error.
  for (const fn of ['createBrand', 'updateBrand', 'deleteBrand']) {
    const i = adminApiJs.indexOf(`async ${fn}(`);
    assert.notEqual(i, -1, `${fn} must exist`);
    const body = adminApiJs.slice(i, i + 400);
    assert.match(body, /resp\.ok === false/, `${fn} must reject on a failure envelope`);
  }
});

test('the create payload requires name and slug', () => {
  // Measured: POST with {} returns VALIDATION_FAILED naming exactly these two.
  assert.match(brandsJs, /A brand needs a name/, 'name is required and must be said before the API says it');
  assert.match(brandsJs, /A brand needs a slug/);
});

test('logo_path is never written — it is derived', () => {
  // Measured: sending logo_path on create echoes back null. Offering a box that
  // discards what you type is the bug this change is about.
  const writes = brandsJs.match(/payload\s*=\s*\{[\s\S]*?\}/);
  assert.ok(writes, 'the create/edit payload must be findable');
  assert.doesNotMatch(writes[0], /logo_path/, 'only logo_url is writable');
  assert.match(writes[0], /logo_url/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Caching — the editor must not read its own write through a CDN.
// ─────────────────────────────────────────────────────────────────────────────

test('the manager never re-reads to show its own write — it patches from the echo', () => {
  // /api/brands is CDN-cached (s-maxage=300, swr=600, measured), so a read issued
  // straight after a write can legitimately return the row as it was BEFORE it.
  // The write's echo is the server's own answer about that row and cannot be
  // stale, so that is what updates local state (the ERR-179 doctrine).
  assert.match(brandsJs, /function applyEcho/, 'the echo must be folded into local state');
  const i = brandsJs.indexOf('async function save(');
  assert.notEqual(i, -1);
  const body = brandsJs.slice(i, i + 1200);
  assert.match(body, /applyEcho\(/, 'save must patch from the echo');
  assert.doesNotMatch(body, /await reload\(\)/, 'a re-read here can be served the pre-write row');
});

test('no cache-buster is used to work around the CDN', () => {
  // ERR-124: a per-request param on a catalog URL makes every call a guaranteed
  // edge MISS and silently undoes the whole optimisation. Patching from the echo
  // is what makes the buster unnecessary rather than merely forbidden.
  assert.doesNotMatch(brandsJs, /Date\.now\(\)|Math\.random\(\)/,
    'no cache-busting interpolation belongs on a catalog URL');
  assert.doesNotMatch(adminApiJs, /getBrandsFresh/, 'the cache-bypassing read must stay removed');
});

test('the propagation delay is stated, not left to be discovered', () => {
  // Measured headers: s-maxage=300, stale-while-revalidate=600, plus a 5-minute
  // client SWR entry. Unsaid, the lag reads as "the toggle did nothing" — which
  // is precisely the class of bug this feature removes.
  assert.match(brandsJs, /PROPAGATION_NOTE/);
  assert.match(brandsJs, /5 minutes/, 'the UI must name the delay in the operator’s own terms');
});

test('a failed brand read shows nothing rather than a partial list', () => {
  assert.match(brandsJs, /could not be read/,
    'half a brand list rendered as if whole is how a missing brand goes unnoticed');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Gating and wiring.
// ─────────────────────────────────────────────────────────────────────────────

test('the manager is owner-only', () => {
  assert.match(brandsJs, /AdminAuth\.isOwner\(\)/, 'the endpoints are super_admin');
  assert.match(brandsJs, /Owner access required/);
});

test('it is reached from the Browse tab and lazy-loaded, never imported at top level', () => {
  assert.match(browseJs, /data-cb-manage-brands/, 'there must be a way in');
  assert.match(browseJs, /import\('\.\/brands\.js'\)/, 'lazy — the pathway loads the same way');
  assert.doesNotMatch(browseJs, /^import .*from '\.\/brands\.js'/m,
    'a static import would load the manager for every Browse visit');
});

test('the Browse grid uses the rows the manager just wrote, not a cached read', () => {
  // Returning from the manager through the 5-minute SWR entry — or through the
  // CDN — would show the operator the state before their own change.
  assert.match(browseJs, /_brandsAfterWrite\s*=\s*Array\.isArray\(rows\)/,
    'the manager must hand its echoed rows back');
  assert.match(browseJs, /_brandsAfterWrite\s*\?\s*Promise\.resolve\(_brandsAfterWrite\)/,
    'and the next render must actually use them — a value nobody reads is not a fix');
});

test('every class the manager emits is styled', () => {
  // An unstyled class renders as unformatted text that still looks deliberate,
  // which is why it survives review.
  const emitted = new Set((brandsJs.match(/admin-brands__[a-z-]+/g) || []));
  const missing = [...emitted].filter(c => !adminCss.includes('.' + c));
  assert.deepEqual(missing, [], `admin.css is missing: ${missing.join(', ')}`);
  assert.ok(adminCss.includes('.admin-cb-headrow'), 'the Browse header row needs its style too');
});

test('the brand logo is size-capped in the admin too', () => {
  // Same trap as the storefront tile: a brand logo is an arbitrary image and some
  // are thousands of pixels tall.
  const i = adminCss.indexOf('.admin-brands__logo img');
  assert.notEqual(i, -1, 'the admin logo cell must bound its image');
  assert.match(adminCss.slice(i, i + 160), /max-height/);
});
