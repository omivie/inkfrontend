/**
 * Review Flywheel — Frontend (Jul 2026)
 * =====================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The backend shipped a "review flywheel": the post-purchase email embeds
 * one-click star ratings. A customer taps a star → confirms on a backend page →
 * the backend records an APPROVED review → it feeds review_count / average_rating
 * → the backend's aggregateRating JSON-LD lights up ★ snippets in Google. The
 * goal is review VOLUME.
 *
 * Per the handoff (review-flywheel-FE-handoff-jul2026.md §1) the frontend must:
 *   §1.1  Handle ?rated=N on the redirect landing pages (product page AND the
 *         /account/reviews fallback) — welcome the customer with a toast.
 *   §1.2  Show the aggregate star rating whenever review_count > 0.
 *   §1.3  Never surface the 409 a one-click rating causes: before offering the
 *         write-a-review form, detect an existing rating and show an
 *         acknowledgement instead.
 * …and the redirect fallback target /account/reviews must actually exist (page +
 * local rewrite + a way to reach it).
 *
 * This suite pins those behaviours to the SOURCE so a future refactor can't
 * silently drop the toast, the guard, the badge, or the page. It reads files as
 * text (house style — node:test + static assertions) and does NOT pin any ?v=
 * cache token (those are content-hashed by the build).
 *
 * Run: node --test tests/review-flywheel-fe-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const READ = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');

const PDP_JS = READ('js/product-detail-page.js');
const PDP_HTML = READ('html/product/index.html');
const API_JS = READ('js/api.js');
const ACCOUNT_JS = READ('js/account.js');
const REVIEWS_JS = READ('js/account-reviews-page.js');
const REVIEWS_HTML = READ('html/account/reviews.html');
const SERVE = JSON.parse(READ('serve.json'));
const VERCEL = JSON.parse(READ('vercel.json'));
const PAGES_CSS = READ('css/pages.css');

// ─────────────────────────────────────────────────────────────────────────
// §1.2  Aggregate rating badge on the PDP hero.
// ─────────────────────────────────────────────────────────────────────────
test('§1.2 the PDP markup carries a hero rating badge that links to the reviews', () => {
    assert.match(PDP_HTML, /id="product-rating-badge"/,
        'html/product/index.html must have #product-rating-badge in the buy-box header');
    // It must anchor to the reviews section so a tap jumps to the reviews.
    const badge = PDP_HTML.match(/<a[^>]*id="product-rating-badge"[^>]*>/);
    assert.ok(badge, 'the badge must be an anchor element');
    assert.match(badge[0], /href="#product-reviews"/,
        'the rating badge must link to #product-reviews');
});

test('§1.2 renderRatingBadge gates on review_count > 0 (same as product cards)', () => {
    assert.match(PDP_JS, /renderRatingBadge\s*\(/, 'renderRatingBadge must exist');
    const defIdx = PDP_JS.indexOf('renderRatingBadge(info) {');
    assert.ok(defIdx !== -1, 'renderRatingBadge must be defined');
    const fn = PDP_JS.slice(defIdx, defIdx + 1100);
    assert.match(fn, /average_rating/, 'must read average_rating');
    assert.match(fn, /review_count/, 'must read review_count');
    // The gate: no rating shown unless an average AND a positive count exist —
    // mirrors js/products.js so cards and PDP agree on "a rating exists".
    assert.match(fn, /count\s*>\s*0/, 'must require review_count > 0 before showing');
    assert.match(fn, /el\.hidden\s*=\s*true/, 'must hide the badge when there is no rating');
    // renderProduct must actually call it.
    assert.match(PDP_JS, /this\.renderRatingBadge\(info\)/,
        'renderProduct() must call renderRatingBadge(info)');
});

// ─────────────────────────────────────────────────────────────────────────
// §1.1  ?rated=N welcome on the product page.
// ─────────────────────────────────────────────────────────────────────────
test('§1.1 the PDP welcomes a one-click rater via ?rated=N and strips the param', () => {
    assert.match(PDP_JS, /handleRatedParam\s*\(/, 'handleRatedParam must exist');
    const defIdx = PDP_JS.indexOf('handleRatedParam(params, section) {');
    assert.ok(defIdx !== -1, 'handleRatedParam must be defined');
    const fn = PDP_JS.slice(defIdx, defIdx + 1600);
    // Only 1–5 are valid ratings.
    assert.match(fn, /rated\s*>=\s*1\s*&&\s*rated\s*<=\s*5/,
        'must bound the rating to 1–5');
    // The exact welcome copy the handoff specifies.
    assert.match(fn, /Thanks for your \$\{rated\}-star rating!/,
        'must show the "Thanks for your N-star rating!" toast');
    assert.match(fn, /showToast/, 'must use the global showToast');
    // Idempotency: the param is removed so a refresh/Back doesn't re-toast, and
    // the canonical-URL rewrite (which preserves the query string) can't carry it.
    assert.match(fn, /searchParams\.delete\('rated'\)/, 'must delete the rated param');
    assert.match(fn, /replaceState/, 'must strip the param from the address bar');
    // …and loadReviews must actually invoke it.
    assert.match(PDP_JS, /this\.handleRatedParam\(params, section\)/,
        'loadReviews() must call handleRatedParam');
});

// ─────────────────────────────────────────────────────────────────────────
// §1.3  Already-rated guard — never surface the 409.
// ─────────────────────────────────────────────────────────────────────────
test('§1.3 the write-a-review form is gated behind an existing-review check', () => {
    // setupReviewForm must be async and consult the user's own reviews before
    // showing the form.
    assert.match(PDP_JS, /async setupReviewForm\(info\)/,
        'setupReviewForm must be async so it can await the existing-review check');
    assert.match(PDP_JS, /_getUserReviewForProduct\s*\(/,
        'a helper must look up the user\'s existing review for this product');
    assert.match(PDP_JS, /API\.getUserReviews\(\)/,
        'the guard must call API.getUserReviews()');
    const setup = PDP_JS.slice(PDP_JS.indexOf('async setupReviewForm(info)'),
        PDP_JS.indexOf('async setupReviewForm(info)') + 1400);
    assert.match(setup, /const existing = await this\._getUserReviewForProduct\(info\.id\)/,
        'setupReviewForm must await the existing-review lookup');
    assert.match(setup, /if \(existing\)\s*\{[\s\S]*renderAlreadyRated[\s\S]*return;/,
        'when a review exists it must render the acknowledgement and NOT wire the form');
});

test('§1.3 the acknowledgement matches on product_id and never surfaces a raw 409', () => {
    const helperIdx = PDP_JS.indexOf('_getUserReviewForProduct(productId) {');
    assert.ok(helperIdx !== -1, '_getUserReviewForProduct must be defined');
    const helper = PDP_JS.slice(helperIdx, helperIdx + 1000);
    assert.match(helper, /product_id/, 'must match the review by product_id');
    assert.match(helper, /catch/, 'must fail-soft (fall back to showing the form) on read error');
    // The acknowledgement panel tells the customer they already rated.
    assert.match(PDP_JS, /renderAlreadyRated\s*\(/, 'renderAlreadyRated must exist');
    const panelIdx = PDP_JS.indexOf('renderAlreadyRated(formWrap, review) {');
    assert.ok(panelIdx !== -1, 'renderAlreadyRated must be defined');
    const panel = PDP_JS.slice(panelIdx, panelIdx + 1200);
    assert.match(panel, /You rated this \$\{rating\}/, 'must say "You rated this N★"');
    assert.match(panel, /pending|approval/i, 'must flag a not-yet-approved review');
    // The old form still exists for first-time reviewers — the 409 message path
    // remains as a backstop, but the primary defence is not offering the form.
    assert.match(PDP_JS, /API\.createReview/, 'the write-review submit path is retained');
});

// ─────────────────────────────────────────────────────────────────────────
// The /account/reviews page — §1.1 fallback target + "my reviews" home.
// ─────────────────────────────────────────────────────────────────────────
test('the /account/reviews page exists with the account chrome and its controller', () => {
    assert.match(REVIEWS_HTML, /class="account-sidebar"/,
        'reviews.html must mount the account sidebar (account.js keys off it)');
    assert.match(REVIEWS_HTML, /<title>My Reviews \| InkCartridges\.co\.nz<\/title>/,
        'reviews.html must have the My Reviews title');
    assert.match(REVIEWS_HTML, /name="robots" content="noindex, nofollow"/,
        'a private account page must be noindex');
    assert.match(REVIEWS_HTML, /src="\/js\/account-reviews-page\.js/,
        'reviews.html must load account-reviews-page.js');
    assert.match(REVIEWS_HTML, /id="reviews-list"/, 'must have a #reviews-list mount');
    assert.match(REVIEWS_HTML, /id="reviews-empty"/, 'must have a #reviews-empty state');
    // Its own sidebar item is the active one.
    const activeItem = REVIEWS_HTML.match(/account-nav__item--active[\s\S]{0,120}?href="([^"]+)"/);
    assert.ok(activeItem, 'reviews.html must mark a sidebar item active');
    assert.equal(activeItem[1], '/account/reviews', 'the active sidebar item is My Reviews');
});

test('the reviews controller reads the API, handles ?rated, and fails LOUD', () => {
    assert.match(REVIEWS_JS, /API\.getUserReviews\(\)/,
        'the controller must load the user\'s own reviews');
    assert.match(REVIEWS_JS, /Thanks for your \$\{rated\}-star rating!/,
        'the fallback landing must welcome a one-click rater too (§1.1)');
    assert.match(REVIEWS_JS, /searchParams\.delete\('rated'\)/,
        'the controller must strip the rated param');
    // Fail-loud: a load error shows an error panel, it must NOT render an empty
    // list as a healthy zero (project rule: fail-soft-must-be-loud).
    assert.match(REVIEWS_JS, /function showError/, 'must have an explicit error state');
    assert.match(REVIEWS_JS, /=== null/,
        'an unreadable body must map to the error state, not an empty success');
    // Guests are bounced to login like the other account controllers.
    assert.match(REVIEWS_JS, /\/account\/login\?redirect=/,
        'guests must be redirected to login');
});

test('account.js skips loadDashboard on /account/reviews', () => {
    assert.match(ACCOUNT_JS, /path\.includes\('\/account\/reviews'\)/,
        'account.js must branch on /account/reviews so loadDashboard() does not fire there');
    // The reviews branch must precede the generic /account catch-all.
    const reviewsIdx = ACCOUNT_JS.indexOf("path.includes('/account/reviews')");
    const genericIdx = ACCOUNT_JS.indexOf("else if (path.includes('/account'))");
    assert.ok(reviewsIdx !== -1 && genericIdx !== -1 && reviewsIdx < genericIdx,
        'the /account/reviews branch must come before the generic /account branch');
});

// ─────────────────────────────────────────────────────────────────────────
// Routing — the dual-rewrite hazard (works live, 404s locally).
// ─────────────────────────────────────────────────────────────────────────
test('both rewrite configs route /account/reviews', () => {
    // Local dev (serve.json) needs an explicit entry — no catch-all there.
    const local = (SERVE.rewrites || []).some(
        (r) => r.source === 'account/reviews' && r.destination === '/html/account/reviews.html');
    assert.ok(local, 'serve.json must rewrite account/reviews → /html/account/reviews.html');
    // Prod (vercel.json) covers it via the /account/:path* catch-all.
    const prod = (VERCEL.rewrites || []).some((r) => r.source === '/account/:path*');
    assert.ok(prod, 'vercel.json must keep the /account/:path* catch-all that covers /account/reviews');
});

// ─────────────────────────────────────────────────────────────────────────
// API + discoverability.
// ─────────────────────────────────────────────────────────────────────────
test('API.getUserReviews is wired to GET /api/user/reviews', () => {
    assert.match(API_JS, /getUserReviews\(\)\s*\{\s*return this\.get\('\/api\/user\/reviews'\)/,
        'API.getUserReviews must GET /api/user/reviews');
});

test('every account page with a sidebar links to My Reviews', () => {
    const dir = path.join(INK, 'html/account');
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
    for (const f of pages) {
        const html = fs.readFileSync(path.join(dir, f), 'utf8');
        // Only pages that render the account sidebar nav are in scope.
        if (!/account-nav__list/.test(html)) continue;
        if (!/href="\/account\/track-order"/.test(html)) continue;
        assert.match(html, /href="\/account\/reviews"/,
            `${f} has the account sidebar but no My Reviews link`);
    }
    // The dashboard also surfaces it as a card.
    const dash = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(dash, /class="dash-nav-card"[\s\S]{0,80}href="\/account\/reviews"|href="\/account\/reviews"[\s\S]{0,80}dash-nav-card/,
        'the account dashboard must have a My Reviews card');
});

test('the review-flywheel CSS ships (badge + acknowledgement + reviews list)', () => {
    assert.match(PAGES_CSS, /\.product-info__rating\b/, 'hero rating badge styles');
    assert.match(PAGES_CSS, /\.review-already__thanks\b/, 'already-rated acknowledgement styles');
    assert.match(PAGES_CSS, /\.account-review-card\b/, 'account reviews list card styles');
});
