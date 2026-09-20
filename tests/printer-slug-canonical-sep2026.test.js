/**
 * Duplicate printer URLs — the canonical contract (ERR-242, Sep 2026)
 * ====================================================================
 *
 * THE BUG. `printer_models` holds some physical printers under more than one
 * row, because the supplier feeds spell them differently. Each row only ever
 * carried its own slice of the cartridges, so one URL looked healthy and its
 * twin looked like an unsupported printer:
 *
 *     "Brother HL L3230CDW"   11 cartridges     "Brother HLL-3230CDW"   0
 *
 * The backend then unioned the link sets, so a customer now gets the full list
 * whichever spelling they land on. THAT FIX CREATED THE SEO PROBLEM:
 * `sitemap-printers.xml` selects on `product_compatibility!inner`, so the
 * previously-empty twin used to be excluded automatically. Now it has links, so
 * it qualifies, and both spellings are submitted to Google as separate pages
 * with byte-identical content.
 *
 * WHAT WAS MEASURED, AND WHY IT IS 15 AND NOT 21. The hand-off this work was
 * assigned from cited `duplicate-printer-urls-FE-handoff-sep2026.md` for the
 * table of "21 pairs". That document was never delivered. So the pairs were
 * derived from the live sitemap instead (4,088 URLs, 2026-09-09) and each was
 * verified against /api/products/printer/:slug as two distinct printer_models
 * rows returning IDENTICAL product sets. That yields FIFTEEN. The remaining six
 * are asked for in printer-canonicals-backend-brief-sep2026.md; until they
 * arrive, a number in a document is not a pair we can act on.
 *
 * THE MATCHING RULE IS NARROW ON PURPOSE. Same brand, slugs equal after
 * stripping every non-alphanumeric character. Edit distance was tried and
 * produced 17,686 "pairs" — `brother-dcp-130c` and `brother-dcp-135c` are one
 * character apart and are DIFFERENT PRINTERS. §4 below pins that the table
 * contains no such pair, because a canonical between two real printers does not
 * consolidate a duplicate, it deletes a working page.
 *
 * THIS IS HALF THE FIX. Googlebot does not read the SPA on these URLs —
 * middleware.js prerenders them and the BACKEND writes that page's canonical
 * (measured self-referential on both twins). What is ours, and what this pins,
 * is that every internal link the site emits names the winner.
 *
 * Run with: node --test tests/printer-slug-canonical-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'inkcartridges', 'js');
const UTILS_SRC = fs.readFileSync(path.join(JS_DIR, 'utils.js'), 'utf8');
const SHOP_JS = fs.readFileSync(path.join(JS_DIR, 'shop-page.js'), 'utf8');

const { PrinterSlug, buildPrinterUrl } = require(path.join(JS_DIR, 'utils.js'));

/** The 15 measured pairs: [loser, winner]. Kept here INDEPENDENTLY of the
 *  implementation so the test is a second opinion, not an echo of the table.
 *
 *  THIS LIST WAS 16 FOR TEN DAYS. The backend asked us on 2026-09-10 to add
 *  `printronix-103.23.` → `printronix-103.23` as a 16th pair we could not have
 *  found ourselves (our discovery ran off the live sitemap, whose slug-shape
 *  gate rejects the `.`), and on 2026-09-16 it WITHDREW that request: an audit
 *  found neither row was a printer. `103.23` is the part number of Printronix's
 *  own ribbon, and both rows held nothing but 8 Epson 103 EcoTank INK products
 *  that had arrived by a bare-number collision. They were twins because they
 *  were both wrong in the same way, which is exactly what identical compat-link
 *  counts — the check both sides used to prove they were twins — cannot tell you.
 *  Both rows are deactivated; §5 pins the retirement AND the survival of the
 *  rule that found it.
 *
 *  Also settled 2026-09-12: the backend's grouping rule counted 21 groups where
 *  we counted 15, and the six-group difference was NOT ours to adopt. Five of
 *  the extra six differ only by a trailing `+`, which is part of the model name
 *  — LQ-300 vs LQ-300+, M880z vs M880z+ are different printers. Verified as
 *  distinct live rows (`epson-1600k3` AND `epson-1600k3+`;
 *  `hp-color-laserjet-m880z`, `…m880z+` AND `…m880z+nfc`). Canonicalising those
 *  would not consolidate a duplicate, it would delete a working page — the same
 *  objection as brother-dcp-130c / brother-dcp-135c, with a different
 *  character. §5 pins the refusal so nobody "completes" the table later, and
 *  the refusal has since been VINDICATED: the backend widened its printer slug
 *  gate on 2026-09-16 and all five of those pages now serve products (measured
 *  2026-09-20: epson-300+ 1, epson-1600k3+ 1, hp-color-laserjet-m880z+ 4). Had
 *  we canonicalised them away, five working pages would have been deleted. */
const MEASURED_PAIRS = [
    ['brother-hll-3230cdw',              'brother-hl-l3230cdw'],
    ['epson-ec-otank-et-2850',           'epson-ecotank-et-2850'],
    ['fuji-xerox-apeosport---vii-c3321', 'fuji-xerox-apeosport-vii-c3321'],
    ['fuji-xerox-apeosport---vii-c4421', 'fuji-xerox-apeosport-vii-c4421'],
    ['fuji-xerox-docuprint-c1190fs',     'fuji-xerox-docuprint-c1190-fs'],
    ['fuji-xerox-docuprint-cm505da',     'fuji-xerox-docuprint-cm505-da'],
    ['hp-laser-jet-enterprise-m651',     'hp-laserjet-enterprise-m651'],
    ['hp-smarttank-300',                 'hp-smart-tank-300'],
    ['hp-smarttank-400',                 'hp-smart-tank-400'],
    ['hp-smarttank-6000',                'hp-smart-tank-6000'],
    ['hp-smarttank-7000',                'hp-smart-tank-7000'],
    ['hp-smarttank-7300',                'hp-smart-tank-7300'],
    ['hp-smarttank-7600',                'hp-smart-tank-7600'],
    ['oki-mc-362dn',                     'oki-mc362dn'],
    ['oki-ml-182',                       'oki-ml182'],
];

// ─────────────────────────────────────────────────────────────────────────
// §1  The table itself
// ─────────────────────────────────────────────────────────────────────────

test('§1 all 15 measured losers map to their winner', () => {
    for (const [loser, winner] of MEASURED_PAIRS) {
        assert.equal(PrinterSlug.canonical(loser), winner,
            `${loser} must canonical to ${winner}`);
    }
});

test('§1 the table holds exactly the 15 measured pairs — no more, no fewer', () => {
    const actual = Object.entries(PrinterSlug.DUPLICATES).sort();
    const expected = MEASURED_PAIRS.map(([l, w]) => [l, w]).sort();
    assert.deepEqual(actual, expected,
        'a pair added without a measurement, or a measured pair dropped, both show up here');
});

test('§1 a winner is never itself a loser (no chains, no cycles)', () => {
    // canonical() resolves in ONE step by design. If a winner appeared as a key
    // the map would need transitive closure and a slug could resolve differently
    // depending on how many times you called it.
    for (const winner of Object.values(PrinterSlug.DUPLICATES)) {
        assert.equal(PrinterSlug.canonical(winner), winner,
            `${winner} is a winner; canonical() must be identity on it`);
        assert.ok(!Object.prototype.hasOwnProperty.call(PrinterSlug.DUPLICATES, winner),
            `${winner} must not also be a key — that is a chain`);
    }
});

// ─────────────────────────────────────────────────────────────────────────
// §2  Identity for everything else — the property that keeps 4,058 URLs working
// ─────────────────────────────────────────────────────────────────────────

test('§2 canonical() is identity for a slug it has never heard of', () => {
    for (const slug of ['brother-mfc-j6945dw', 'hp-officejet-8010', 'canon-pixma-ts3160',
                        'epson-ecotank-et-4850', 'oki-c332dn']) {
        assert.equal(PrinterSlug.canonical(slug), slug);
    }
});

test('§2 canonical() does not invent an answer for junk input', () => {
    // Returns the INPUT, not '' and not null: the caller's own null-check must
    // still govern. buildPrinterUrl checks the raw slug before calling us.
    assert.equal(PrinterSlug.canonical(''), '');
    assert.equal(PrinterSlug.canonical(null), null);
    assert.equal(PrinterSlug.canonical(undefined), undefined);
    assert.equal(PrinterSlug.canonical(42), 42);
    assert.equal(PrinterSlug.canonical({}) instanceof Object, true);
});

test('§2 canonical() is case-insensitive on input, lower-case on output', () => {
    assert.equal(PrinterSlug.canonical('HP-SmartTank-7300'), 'hp-smart-tank-7300');
    assert.equal(PrinterSlug.canonical('OKI-ML-182'), 'oki-ml182');
});

test('§2 isDuplicate answers only for spellings we stopped advertising', () => {
    assert.equal(PrinterSlug.isDuplicate('hp-smarttank-7300'), true);
    assert.equal(PrinterSlug.isDuplicate('hp-smart-tank-7300'), false, 'the winner is not a duplicate');
    assert.equal(PrinterSlug.isDuplicate('brother-mfc-j6945dw'), false);
    assert.equal(PrinterSlug.isDuplicate(null), false);
});

// ─────────────────────────────────────────────────────────────────────────
// §3  Every internal link the site emits names the winner
// ─────────────────────────────────────────────────────────────────────────

test('§3 buildPrinterUrl emits the winner across every payload shape', () => {
    // The five shapes tests/brand-canonical-audit-may2026.test.js already pins.
    const shapes = [
        { slug: 'hp-smarttank-7300', brand_slug: 'hp' },
        { printer_slug: 'hp-smarttank-7300', brand: { slug: 'hp' } },
        { slug: 'hp-smarttank-7300', printer_models: { brand_slug: 'hp' } },
        { slug: 'hp-smarttank-7300', brand: 'HP' },
        { slug: 'hp-smarttank-7300', brand_name: 'HP' },
    ];
    for (const s of shapes) {
        assert.equal(buildPrinterUrl(s), '/shop?brand=hp&printer_slug=hp-smart-tank-7300',
            `shape ${JSON.stringify(s)} must emit the winning slug`);
    }
});

test('§3 buildPrinterUrl canonicalises the unbranded form too', () => {
    assert.equal(buildPrinterUrl({ slug: 'oki-ml-182' }, { allowUnbranded: true }),
        '/shop?printer_slug=oki-ml182');
});

test('§3 canonicalising a slug never resurrects a URL that should be null', () => {
    // A duplicate slug with no recoverable brand is still refused in strict
    // mode. Mapping the slug must not change the branded/unbranded decision.
    assert.equal(buildPrinterUrl({ slug: 'hp-smarttank-7300' }), null);
    assert.equal(buildPrinterUrl({ brand_slug: 'hp' }), null, 'no slug is still null');
});

test('§3 a non-duplicate slug is byte-identical to what it was before', () => {
    assert.equal(buildPrinterUrl({ slug: 'brother-mfc-j6945dw', brand_slug: 'brother' }),
        '/shop?brand=brother&printer_slug=brother-mfc-j6945dw');
});

// ─────────────────────────────────────────────────────────────────────────
// §4  The rule that keeps this safe — and the trap it refuses
// ─────────────────────────────────────────────────────────────────────────

test('§4 every pair differs ONLY in separators — never in an alphanumeric', () => {
    // This is the whole safety argument. `brother-dcp-130c` and
    // `brother-dcp-135c` are one edit apart and are different printers; the only
    // difference that is safe to treat as a spelling variant is punctuation.
    const strip = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [loser, winner] of Object.entries(PrinterSlug.DUPLICATES)) {
        assert.equal(strip(loser), strip(winner),
            `${loser} vs ${winner} differ in an alphanumeric character — these are ` +
            'two different printers, not two spellings of one. Canonicalising them ' +
            'would delete a working page.');
    }
});

test('§4 the table refuses a known-different printer pair', () => {
    // A negative control. If someone ever pastes a fuzzy-matched list in here,
    // this is the assertion that catches it.
    for (const s of ['brother-dcp-130c', 'brother-dcp-135c', 'brother-dcp-150c',
                     'optima-sp50', 'optima-sp55', 'amano-bx3000', 'amano-bx6000']) {
        assert.equal(PrinterSlug.canonical(s), s,
            `${s} must be untouched — it is a real printer, not a duplicate spelling`);
    }
});

// ─────────────────────────────────────────────────────────────────────────
// §5  ONE copy (ERR-187/192)
// ─────────────────────────────────────────────────────────────────────────

test('§5 the pair table exists in exactly one file', () => {
    // ERR-187/192: a hardcoded brand array reached six copies in this repo, one
    // of them in CSS, and relocating a rule instead of sharing it left a stale
    // duplicate 2,400 lines down the same file. A second copy of THIS table
    // would be worse: it decides which URL Google indexes.
    const roots = [path.join(ROOT, 'inkcartridges'), path.join(ROOT, 'scripts'), path.join(ROOT, 'tests')];
    const files = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); }
            else if (/\.(js|mjs|css|html|json)$/.test(e.name)) files.push(full);
        }
    };
    roots.forEach((r) => { if (fs.existsSync(r)) walk(r); });

    // A sentinel that only a real second copy of the map would contain: the
    // loser spelling paired with the winner on the same line.
    const offenders = files.filter((f) => {
        if (f === path.join(JS_DIR, 'utils.js')) return false;            // the owner
        if (f === __filename) return false;                                // this test's second opinion
        if (path.basename(f) === 'probe-printer-canonicals.mjs') return false; // reads the owner, see §6
        return /'hp-smarttank-7300'\s*:\s*'hp-smart-tank-7300'/.test(fs.readFileSync(f, 'utf8'));
    });
    assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), [],
        'the duplicate-slug table lives in utils.js and nowhere else');
});

test('§5 the probe reads the table rather than restating it', () => {
    // ERR-231: "the probe was certifying a REPLICA of the escaper." A probe that
    // hardcodes its own copy of the pairs cannot catch the table being wrong.
    const probe = path.join(ROOT, 'scripts', 'probe-printer-canonicals.mjs');
    assert.ok(fs.existsSync(probe), 'probe:printer-canonicals must exist');
    const src = fs.readFileSync(probe, 'utf8');
    assert.match(src, /utils\.js/, 'the probe must load the real table out of utils.js');
});

// ─────────────────────────────────────────────────────────────────────────
// §6  Wiring — the call sites that make it count
// ─────────────────────────────────────────────────────────────────────────

test('§6 buildPrinterUrl routes its slug through PrinterSlug', () => {
    assert.match(UTILS_SRC, /const slug = PrinterSlug\.canonical\(rawSlug\);/,
        'every internal printer link must be canonicalised at the one place they are built');
});

test('§6 PrinterSlug is exposed on window and via module.exports', () => {
    // ERR-167: `window.Security` did not exist because security.js was a bare
    // const, so every `window.Security?.x ? … : fallback` guard was an OFF
    // SWITCH. shop-page.js reads PrinterSlug through such a guard, so the
    // global assignment is load-bearing, not cosmetic.
    assert.match(UTILS_SRC, /window\.PrinterSlug = PrinterSlug;/,
        'shop-page.js reads window/global PrinterSlug — without this its guard silently takes the fallback');
    assert.ok(PrinterSlug && typeof PrinterSlug.canonical === 'function',
        'module.exports must carry PrinterSlug');
});

test('§6 shop-page.js canonicalises the printer_slug it advertises', () => {
    assert.match(SHOP_JS, /PrinterSlug\.canonical\(lc\(this\.state\.printer\)\)/,
        'the /shop canonical must name the winner');
});

test('§6 a printer canonical carries a brand', () => {
    // middleware.js gates the printer prerender on brandSlug && printerSlug, and
    // buildPrinterUrl refuses to emit the unbranded form for indexable links — so
    // a bare ?printer_slug= canonical pointed at a shape the rest of the system
    // does not consider canonical.
    assert.match(SHOP_JS, /const printerBrand = printerSlug \? \(this\.state\.printerBrand \|\| brand \|\| null\) : null;/);
    assert.match(SHOP_JS, /if \(brand \|\| printerBrand\) params\.set\('brand',\s*lc\(brand \|\| printerBrand\)\)/);
});

// ─────────────────────────────────────────────────────────────────────────
// §5  The five pairs we REFUSED, and why they must stay refused (ERR-249)
// ─────────────────────────────────────────────────────────────────────────

test('§5 a trailing + is NEVER canonicalised away — those are different printers', () => {
    // The backend's own rule, shipped 2026-09-10: two slugs are the same
    // machine when they differ only in SEPARATORS (hyphen, underscore, space)
    // plus a trailing full stop. `+` is preserved, because it is part of the
    // model name. Verified live the same week — both spellings exist as
    // separate rows in /api/printers/search, and a third (`…m880z+nfc`) proves
    // the suffix carries meaning rather than being noise.
    //
    // This is the objection that saved five pages. Our own grouping rule
    // ("strip every non-alphanumeric") would have merged all five, and only
    // missed them by accident: encodeURIComponent writes `+` as `%2B`, so
    // normalising the URL string rather than the slug left `…k32b` and they
    // never grouped. An accident is not a safeguard — hence this test.
    const PLUS_PAIRS = [
        ['epson-300',                'epson-300+'],
        ['epson-1600k3',             'epson-1600k3+'],
        ['epson-1900k2',             'epson-1900k2+'],
        ['hp-color-laserjet-m880z',  'hp-color-laserjet-m880z+'],
        ['hp-colour-laserjet-m880z', 'hp-colour-laserjet-m880z+'],
    ];
    for (const [bare, plus] of PLUS_PAIRS) {
        assert.equal(PrinterSlug.canonical(bare), bare,
            `${bare} is a real printer and must canonical to itself`);
        assert.equal(PrinterSlug.canonical(plus), plus,
            `${plus} is a DIFFERENT real printer — canonicalising it deletes a working page`);
        assert.ok(!PrinterSlug.isDuplicate(plus), `${plus} must never be treated as a duplicate`);
    }
});

test('§5 the Printronix pair is RETIRED — absent from the table, identity in the code', () => {
    // 2026-09-20. This pair was here for ten days and is now gone, because the
    // backend withdrew its own request: neither row was a printer. `103.23` is
    // the part number of Printronix's own RIBBON, and both rows held nothing but
    // 8 Epson 103 EcoTank INK products that arrived by a bare-number collision.
    //
    // ***A REMOVAL NEEDS A TEST MORE THAN AN ADDITION DOES.*** The old version of
    // this test asserted the mapping existed. Deleting that assertion alone would
    // leave nothing at all pointing at this slug, so the next reader of the
    // backend's 2026-09-10 document — which asks in plain words for the pair to be
    // added — has no way to discover that the ask was withdrawn, and re-adds it.
    // These three assertions are what makes the absence deliberate rather than
    // merely true.
    for (const slug of ['printronix-103.23.', 'printronix-103.23']) {
        assert.ok(!PrinterSlug.isDuplicate(slug),
            `${slug} is retired, not consolidated — there is no winner to canonicalise to`);
        assert.equal(PrinterSlug.canonical(slug), slug,
            `${slug} must come back unchanged; a canonical here would advertise a 404`);
    }
    assert.ok(!Object.keys(PrinterSlug.DUPLICATES).some((k) => k.startsWith('printronix')),
        'no Printronix spelling belongs in the table');
    assert.ok(!Object.values(PrinterSlug.DUPLICATES).some((v) => v.startsWith('printronix')),
        'and none may be a winner either');

    // The reason has to survive in the file, or this looks like an oversight to
    // anyone holding the document that asked for the pair.
    assert.match(UTILS_SRC, /RETIRED, NOT RENAMED/,
        'utils.js must say the pair was retired rather than merged');
    assert.match(UTILS_SRC, /ribbon/i,
        'and why: 103.23 is a ribbon part number, not a model number');
});

test('§5 the RULE that found the pair outlives the pair (a 17th of that shape must group)', () => {
    // THE HAZARD THIS PINS. The Printronix row and the trailing-full-stop rule
    // arrived in the same change and are easy to mistake for one thing. They are
    // not: the INSTANCE was a data defect, the RULE is still correct, and the
    // backend said so explicitly — "the trailing-full-stop rule stays in
    // printerSlugKey and is still pinned; the next feed row spelled that way must
    // still group. Only this instance is gone."
    //
    // Read from the ONE owner (the probe's `strip`), extracted rather than
    // re-typed. ERR-231 is this repo's record of a probe certifying a REPLICA of
    // the thing it was meant to check; a second copy of this rule in a test would
    // be that again, and would keep passing after the real rule was edited.
    // Comments stripped first, via the repo's single owner for that job: the
    // declaration carries trailing `//` comments on two of its lines, so the
    // statement's own terminating `;` is followed by trailing spaces, not the newline
    // the naive `;\n` would need. Both details are why this extracts rather than
    // re-types: the rule may be reformatted, and this must still find it.
    const probeSrc = stripComments(fs.readFileSync(
        path.join(ROOT, 'scripts', 'probe-printer-canonicals.mjs'), 'utf8'));
    const m = probeSrc.match(/const strip = \(s\) => String\(s\)[\s\S]*?;[ \t]*\n/);
    assert.ok(m, 'probe-printer-canonicals.mjs must still declare `strip` — it is the rule');
    // eslint-disable-next-line no-new-func
    const strip = new Function(`${m[0]} return strip;`)();

    assert.equal(strip('acme-99.9.'), strip('acme-99.9'),
        'a TRAILING full stop is a data-entry artefact and must still merge');
    assert.equal(strip('oki-mc-362dn'), strip('oki-mc362dn'),
        'separators must still merge');
    assert.notEqual(strip('epson-1600k3+'), strip('epson-1600k3'),
        '`+` is part of the model name and must NEVER merge');
    assert.notEqual(strip('brother-dcp-130c'), strip('brother-dcp-135c'),
        'two real printers one character apart must stay distinct');
    assert.notEqual(strip('printronix-103.23'), strip('printronix-10323'),
        'a MID-slug full stop is not an artefact and must not be stripped');
});

test('§5 a `+` in an emitted URL is PERCENT-ENCODED — a bare one decodes to a space', () => {
    // The five `+` pairs we refused are no longer hypothetical pages. The backend
    // widened its printer slug gate on 2026-09-16, and measured 2026-09-20 all
    // five now serve products (epson-300+ 1, epson-1600k3+ 1,
    // hp-color-laserjet-m880z+ 4, hp-designjet-z9+-24in 11). So the refusal
    // stopped being a defence of an empty page and became a link we have to emit
    // CORRECTLY.
    //
    // ***`+` IS THE ONE CHARACTER THAT CHANGES MEANING BETWEEN A PATH AND A QUERY
    // STRING.*** In a query string it is legacy-decoded as a SPACE, so a link
    // written with a literal `+` names a printer whose slug ends in a space — a
    // different slug, and one no row has. encodeURIComponent writes `%2B`, which
    // is why buildPrinterUrl is correct today; this pins it, because the obvious
    // "simplification" (template-literal the slug straight in) is silent.
    for (const slug of ['epson-300+', 'epson-1600k3+', 'hp-color-laserjet-m880z+',
                        'hp-designjet-z9+-24in']) {
        const url = buildPrinterUrl({ slug, brand_slug: 'epson' });
        assert.ok(url, `${slug} must still produce a URL`);
        assert.ok(!/\+/.test(url),
            `${url} carries a bare + — URLSearchParams would read it back as a space`);
        assert.match(url, /%2B/, `${slug} must be percent-encoded`);

        // The round trip is the assertion that matters: what a browser hands back
        // to parseURLState must be the slug we started with.
        const readBack = new URLSearchParams(url.split('?')[1]).get('printer_slug');
        assert.equal(readBack, slug,
            'the slug must survive the round trip through the query string');
    }

    // Negative control: the same round trip on a BARE `+` really does corrupt,
    // so the assertion above is not passing on a property of URLSearchParams that
    // does not exist.
    assert.equal(new URLSearchParams('printer_slug=epson-300+').get('printer_slug'),
        'epson-300 ', 'a bare + decodes to a space — this is the hazard being guarded');
});

test('§5 whole-value matching — a slug that is a PREFIX of another is not a hit', () => {
    // Measured 2026-09-12 while checking the prerendered HTML: the page for
    // oki-mc-362dn contains the string "oki-mc-362dn" once, and that occurrence
    // is inside `oki-mc-362dnw` — a different printer. Any check that greps for
    // a slug as a substring will report a duplicate link that is not there, or
    // miss one that is. ERR-198, same shape: no value may be a prefix of another.
    assert.equal(PrinterSlug.canonical('oki-mc-362dnw'), 'oki-mc-362dnw',
        'a longer model that merely STARTS WITH a loser slug must be untouched');
    assert.ok(!PrinterSlug.isDuplicate('oki-mc-362dnw'));
    assert.equal(PrinterSlug.canonical('printronix-103.23.x'), 'printronix-103.23.x');
});
