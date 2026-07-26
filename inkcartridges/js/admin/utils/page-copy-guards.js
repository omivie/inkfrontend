/**
 * PAGE-COPY-GUARDS.JS
 * ===================
 * Every check that stands between an owner's edit and a commit to the repo
 * that builds the production site.
 *
 * THIS IS THE SECURITY BOUNDARY, AND IT IS ADVISORY IN THE BROWSER.
 * ----------------------------------------------------------------
 * The admin runs these for immediate feedback. That is a convenience, not a
 * control: anyone who can reach the save endpoint can skip the browser
 * entirely. The backend MUST run the identical checks before it writes a blob
 * — see page-copy-editor-backend-brief.md. If you are reading this while
 * adding a check, add it to the brief in the same change.
 *
 * WHY REJECT AND NOT STRIP
 * ------------------------
 * Every failure below is a hard reject naming the offending node, never a
 * silent sanitise. Silent stripping trains the owner to believe something
 * saved when part of it did not, which is the ERR-069 trap in a different
 * costume ("Saved. Live on next page-load." into a table nothing read). If a
 * save cannot be completed exactly as composed, it must not be completed.
 *
 * NO PRIVATE COPIES OF SHARED LISTS
 * ---------------------------------
 * BANNED_CLAIM_PATTERNS and the business facts come from LegalConfig
 * (js/legal-config.js) at call time — never duplicated here. legal-config.js
 * is an IIFE that assigns to the global, so the browser gets it from
 * window.LegalConfig and node gets it by require()-ing the file first. If the
 * config is missing, these guards FAIL LOUD (GUARD_UNAVAILABLE) rather than
 * quietly passing an unchecked edit: an absent list must never read as "no
 * violations found" (ERR-063 / ERR-068 / ERR-075).
 */

import {
    INLINE_TAGS,
    parseRegion,
    serializeRegion,
    collectBindings,
    walkInline,
    decodeEntities,
} from './page-copy-model.js';

import { getSectionRule } from './page-copy-regions.js';

/* ─────────────────────────── entity handling ─────────────────────────── */

/**
 * Decoded, whitespace-collapsed, trimmed — the form every text check uses.
 *
 * decodeEntities is imported from page-copy-model.js. There is exactly ONE
 * entity table in this feature; a private copy here would drift from the one
 * the serializer uses, and these checks would then be reading different text
 * than the file actually receives.
 *
 * Curly quotes are folded to their ASCII equivalents. The pages are written
 * with `&rsquo;` throughout, so without this fold a required phrase would have
 * to be typed with the exact same smart-quote codepoint to match, and a banned
 * claim could evade the sweep just by using a typographic apostrophe.
 * tests/genuine-vs-compatible-warranty.test.js normalises the same way.
 */
function readableText(text) {
    return decodeEntities(text)
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

/* ─────────────────────────── markup allowlist ─────────────────────────── */

/**
 * Attributes permitted on an inline element, by tag. Anything absent is a
 * reject — including `class`, `id` and `style`, none of which appear in the
 * shipped prose and all of which are levers for breaking the page layout or
 * smuggling presentation into content.
 */
const ALLOWED_INLINE_ATTRS = {
    a:      new Set(['href', 'data-legal-bind', 'target', 'rel', 'title']),
    span:   new Set(['data-legal-bind', 'lang']),
    strong: new Set(['data-legal-bind']),
    em:     new Set(['data-legal-bind']),
    u:      new Set([]),
    small:  new Set(['data-legal-bind']),
    sup:    new Set([]),
    sub:    new Set([]),
    abbr:   new Set(['title']),
    code:   new Set([]),
    br:     new Set([]),
};

/** Link targets we will write into a shipped page. */
function isSafeHref(value) {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    if (v === '') return false;
    if (/^https:\/\//i.test(v)) return true;
    if (/^mailto:/i.test(v)) return true;
    if (/^tel:/i.test(v)) return true;
    if (/^\/(?!\/)/.test(v)) return true;   // site-relative, but not protocol-relative //evil
    if (/^#[\w-]+$/.test(v)) return true;   // same-page fragment
    return false;
}

/* ─────────────────────────── text extraction ─────────────────────────── */

/** Run `fn` over every inline node list in a block list. */
function eachInline(blocks, fn) {
    for (const b of blocks) {
        if (b.type === 'paragraph' || b.type === 'subheading') fn(b.inline);
        else if (b.type === 'list') b.items.forEach(fn);
        else if (b.type === 'callout') {
            if (b.title) fn(b.title);
            b.body.forEach(fn);
        }
    }
}

/**
 * Text the owner typed, EXCLUDING anything inside a [data-legal-bind] element.
 *
 * Bound text is placeholder copy that js/legal-page.js overwrites at render
 * time from LegalConfig, so a GST number inside a bind span is correct by
 * construction. The same digits typed as plain prose are a second, unbound
 * copy of a business fact — which is exactly how a fact drifts away from the
 * backend's src/utils/trustSignals.js. Hence: only unbound text is checked.
 */
function unboundText(blocks) {
    const parts = [];
    const visit = (nodes) => {
        for (const n of nodes) {
            if (n.type === 'text') { parts.push(n.raw); continue; }
            if (n.type !== 'element') continue;
            const bound = (n.attrs || []).some(a => a.name === 'data-legal-bind');
            if (bound) continue;                       // skip the whole bound subtree
            if (n.children) visit(n.children);
        }
    };
    eachInline(blocks, visit);
    return readableText(parts.join(' '));
}

/** All text, bound or not — what the banned-claim and phrase checks read. */
function allText(blocks) {
    const parts = [];
    const visit = (nodes) => {
        for (const n of nodes) {
            if (n.type === 'text') parts.push(n.raw);
            else if (n.children) visit(n.children);
        }
    };
    eachInline(blocks, visit);
    for (const b of blocks) {
        if (b.type === 'verbatim') parts.push(b.raw.replace(/<[^>]*>/g, ' '));
    }
    return readableText(parts.join(' '));
}

/* ─────────────────────────── individual checks ─────────────────────────── */

function err(code, message, detail) {
    return detail === undefined ? { code, message } : { code, message, detail };
}

/** Tags and attributes must sit inside the allowlist. */
function checkMarkup(blocks, errors) {
    eachInline(blocks, (nodes) => {
        walkInline(nodes, (el) => {
            if (!INLINE_TAGS.has(el.name)) {
                errors.push(err('DISALLOWED_TAG',
                    `<${el.name}> is not allowed in page copy.`, el.name));
                return;
            }
            const allowed = ALLOWED_INLINE_ATTRS[el.name] || new Set();
            for (const a of el.attrs || []) {
                if (/^on/i.test(a.name)) {
                    errors.push(err('DISALLOWED_ATTR',
                        `Event handler "${a.name}" is not allowed on <${el.name}>.`, a.name));
                    continue;
                }
                if (!allowed.has(a.name)) {
                    errors.push(err('DISALLOWED_ATTR',
                        `Attribute "${a.name}" is not allowed on <${el.name}>.`, `${el.name}[${a.name}]`));
                    continue;
                }
                if (a.name === 'href' && !isSafeHref(a.value)) {
                    errors.push(err('UNSAFE_HREF',
                        `Link "${a.value}" is not allowed. Use https://, mailto:, tel:, a site path `
                        + `starting with /, or a #fragment.`, a.value));
                }
            }
        });
    });
}

/** Bound facts must be identical, in order, before and after. */
function checkBindings(before, after, errors) {
    const b = collectBindings(before);
    const a = collectBindings(after);
    if (b.join('|') === a.join('|')) return;

    const count = (list) => list.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
    const cb = count(b);
    const ca = count(a);
    const keys = new Set([...cb.keys(), ...ca.keys()]);
    for (const k of keys) {
        const n0 = cb.get(k) || 0;
        const n1 = ca.get(k) || 0;
        if (n0 === n1) continue;
        errors.push(err('BINDING_CHANGED',
            n1 < n0
                ? `The auto-filled value "${k.split(':')[1]}" was removed. It is filled in from `
                  + `site settings on every page load, so it cannot be deleted or retyped by hand.`
                : `The auto-filled value "${k.split(':')[1]}" was duplicated or invented.`,
            k));
    }
    if (!errors.some(e => e.code === 'BINDING_CHANGED')) {
        errors.push(err('BINDING_CHANGED',
            'The auto-filled values were reordered relative to the text around them.'));
    }
}

/** Read-only blocks must come through untouched, in the same order. */
function checkVerbatim(before, after, errors) {
    const raws = (blocks) => blocks.filter(b => b.type === 'verbatim').map(b => b.raw);
    const b = raws(before);
    const a = raws(after);
    if (b.length !== a.length || b.some((r, i) => r !== a[i])) {
        errors.push(err('VERBATIM_CHANGED',
            'A read-only part of this section (a table, address, icon list, or accordion) was '
            + 'changed. Those cannot be edited here.'));
    }
}

/** A business fact must never appear as plain prose outside its binding. */
function checkBusinessFacts(after, legalConfig, errors) {
    const text = unboundText(after);
    const addr = legalConfig.address || {};
    const facts = [
        ['NZBN', legalConfig.nzbn],
        ['GST number', legalConfig.gstNumber],
        ['phone number', legalConfig.phoneDisplay],
        ['phone number', legalConfig.phoneE164],
        ['email address', legalConfig.email],
        ['street address', addr.street],
    ];
    const seen = new Set();
    for (const [label, value] of facts) {
        if (!value) continue;
        const needle = readableText(value);
        if (!needle || seen.has(needle)) continue;
        if (text.includes(needle)) {
            seen.add(needle);
            errors.push(err('FACT_INLINED',
                `The ${label} ("${value}") was typed directly into the text. Business facts are `
                + `filled in automatically from site settings so they can never disagree with the `
                + `rest of the site — remove it here and change it in Settings instead.`,
                value));
        }
    }
}

/** The OEM-warranty claim class that suspended the ad account. */
function checkBannedClaims(after, legalConfig, errors) {
    const patterns = legalConfig.BANNED_CLAIM_PATTERNS;
    if (!Array.isArray(patterns) || !patterns.length) {
        errors.push(err('GUARD_UNAVAILABLE',
            'The banned-claim list (LegalConfig.BANNED_CLAIM_PATTERNS) could not be read, so this '
            + 'edit cannot be checked for prohibited warranty claims. Refusing to save.'));
        return;
    }
    const text = allText(after);
    for (const re of patterns) {
        const m = re.exec ? re.exec(text) : null;
        if (m) {
            errors.push(err('BANNED_CLAIM',
                `This text makes a claim about the printer manufacturer's warranty ("${m[0]}"). `
                + `That claim class is what suspended the Google Ads account — you may describe our `
                + `own guarantee and statutory CGA rights, but never what an OEM will or won't honour.`,
                m[0]));
        }
    }
}

/** Sentences the compliance suites pin must survive the edit. */
function checkRequiredPhrases(after, phrases, errors) {
    if (!phrases || !phrases.length) return;
    const text = allText(after);
    for (const phrase of phrases) {
        if (!text.includes(readableText(phrase))) {
            errors.push(err('MISSING_PHRASE',
                `This section must still contain: "${phrase}" — it is checked by the compliance `
                + `test suite and, in some cases, was supplied by legal for the Google Ads appeal.`,
                phrase));
        }
    }
}

/* ─────────────────────────── entry point ─────────────────────────── */

/**
 * Validate one proposed section edit.
 *
 * @param {Object} input
 * @param {string} input.slug         doc slug, e.g. 'returns'
 * @param {string} input.sectionId    section id, e.g. 'change-of-mind'
 * @param {Array}  input.before       blocks as currently shipped
 * @param {Array}  input.after        blocks the owner composed
 * @param {number} input.indent       column the blocks sit at (for the re-parse check)
 * @param {Object} [input.legalConfig] defaults to the global LegalConfig
 * @returns {{ok: boolean, errors: Array<{code, message, detail?}>}}
 */
function checkRegionEdit({ slug, sectionId, before, after, indent = 28, legalConfig }) {
    const errors = [];
    const cfg = legalConfig
        || (typeof globalThis !== 'undefined' ? globalThis.LegalConfig : null);

    if (!cfg) {
        return {
            ok: false,
            errors: [err('GUARD_UNAVAILABLE',
                'Site settings (LegalConfig) could not be loaded, so this edit cannot be checked. '
                + 'Refusing to save.')],
        };
    }

    const rule = getSectionRule(slug, sectionId);
    if (rule.state !== 'editable') {
        return { ok: false, errors: [err('LOCKED_SECTION', rule.reason || 'This section is read-only.')] };
    }

    if (!Array.isArray(before) || !Array.isArray(after) || !after.length) {
        return { ok: false, errors: [err('UNPARSEABLE', 'This section could not be read as editable content.')] };
    }

    // The edit must survive its own round trip. If serializing then re-parsing
    // does not reproduce the same markup, the model cannot represent what was
    // composed and the file would degrade on the next edit — refuse now.
    let roundTripped = null;
    try {
        const html = serializeRegion(after, indent);
        roundTripped = parseRegion(html);
        if (roundTripped === null || serializeRegion(roundTripped, indent) !== html) {
            errors.push(err('UNPARSEABLE',
                'This content cannot be saved without changing its structure. Simplify the '
                + 'formatting — plain paragraphs, lists, bold and links are supported.'));
        }
    } catch (e) {
        errors.push(err('UNPARSEABLE', `This content could not be written back: ${e.message}`));
    }

    checkMarkup(after, errors);
    checkVerbatim(before, after, errors);
    checkBindings(before, after, errors);
    checkBusinessFacts(after, cfg, errors);
    checkBannedClaims(after, cfg, errors);
    checkRequiredPhrases(after, rule.requiredPhrases, errors);

    return { ok: errors.length === 0, errors };
}

export {
    checkRegionEdit,
    // exported for tests and for the backend brief's reference implementation
    decodeEntities,
    readableText,
    isSafeHref,
    unboundText,
    allText,
    ALLOWED_INLINE_ATTRS,
    checkMarkup,
    checkBindings,
    checkVerbatim,
    checkBusinessFacts,
    checkBannedClaims,
    checkRequiredPhrases,
};
