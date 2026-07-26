/**
 * PAGE-COPY-REGIONS.JS
 * ====================
 * The manifest: which document sections the owner may edit from the admin
 * Page Copy screen, which are read-only, and which sentences must survive an
 * edit because CI pins them.
 *
 * WHY AN ALLOWLIST IS CORRECT HERE
 * --------------------------------
 * ERR-063's lesson is that a hand-maintained FILES_TO_SCAN allowlist in front
 * of a compliance *scanner* fails open — a file nobody remembered to list is a
 * file nobody scanned, so banned copy shipped through two "fixed" reports.
 *
 * This module is the opposite shape. It is an *authoring gate*, and it fails
 * CLOSED: a section absent from `sections` cannot be edited at all. A newly
 * added section is therefore read-only until somebody deliberately lists it,
 * and tests/page-copy-editor-jul2026.test.js turns red until they do. Do not
 * "fix" that test by making unlisted sections default to editable.
 *
 * THREE STATES
 * ------------
 *   editable — the owner may rewrite the prose, subject to the guards in
 *              page-copy-guards.js.
 *   locked   — shown in the UI, read-only, with `reason` rendered next to it
 *              so the screen never looks broken or arbitrarily incomplete.
 *   (implicit) a region whose blocks are all `verbatim` — tables, <details>
 *              accordions, <dl> fact lists, inline-SVG cards — is read-only
 *              regardless of state, because page-copy-model.js cannot express
 *              that markup. It is still listed so the UI can explain itself.
 *
 * REQUIRED PHRASES
 * ----------------
 * Rather than lock a whole section because one sentence in it is legally
 * vetted, an editable region may declare `requiredPhrases`. The guard rejects
 * a save that drops one. This is deliberately narrower than a lock: it lets
 * the owner rewrite the paragraph around a pinned sentence, and it enforces
 * exactly what the compliance suites enforce — no more, no less.
 *
 * Each phrase below traces to a live assertion:
 *   tests/genuine-vs-compatible-warranty.test.js  — the two vetted sentences
 *   tests/legal-pages.test.js                     — CGA / in-trade / Privacy Act
 *   tests/reappeal-disclaimers-jul2026.test.js    — the 3–5 business-day SLA
 * Deleting a phrase here does not make the CI assertion go away; it only means
 * the owner finds out at `npm test` instead of at save time.
 *
 * Phrases are matched against entity-DECODED, whitespace-collapsed text, so
 * write them the way a reader sees them ("3–5 business days", not
 * "3&ndash;5 business days").
 */

/** Reasons, written once so the same wording appears on every locked region. */
const REASON = {
    FACTS: 'These are business facts bound from js/legal-config.js — NZBN, GST number, '
        + 'address, phone. Change them there (and in the backend\'s src/utils/trustSignals.js, '
        + 'which must move with it), not here.',
    STRUCTURE: 'This section is built from markup the editor cannot safely rewrite '
        + '(a data table, an icon card, or an accordion). Editing it needs a developer.',
    FAQ: 'The visible questions here are duplicated in a FAQPage JSON-LD block at the top of '
        + 'faq.html. Editing one without the other would make the structured data disagree with '
        + 'the page, so both have to change together — that needs a developer.',
};

/**
 * doc → { title, path, url, sections: { id: {state, reason?, requiredPhrases?} } }
 *
 * `title` is the admin card label only. The heading shown above each region is
 * read from the file's own <h2> at load time — never duplicated here, because a
 * second copy of a heading is a second thing to drift.
 */
const PAGE_COPY_DOCS = {
    about: {
        title: 'About Us',
        path: 'html/about.html',
        url: '/about',
        sections: {
            'story':            { state: 'editable' },
            'values':           { state: 'locked', reason: REASON.STRUCTURE },
            'how-we-work':      { state: 'editable' },
            'brands':           { state: 'editable' },
            'where-we-ship':    { state: 'editable' },
            'business-details': { state: 'locked', reason: REASON.FACTS },
            'consumer-rights':  { state: 'editable', requiredPhrases: ['Consumer Guarantees Act 1993'] },
            'visit':            { state: 'locked', reason: REASON.FACTS },
            'links':            { state: 'editable' },
        },
    },

    terms: {
        title: 'Terms & Conditions',
        path: 'html/terms.html',
        url: '/terms',
        sections: {
            'who-we-are': { state: 'editable', requiredPhrases: ['in trade', 'Fair Trading Act 1986'] },
            'acceptance': { state: 'editable' },
            'ordering':   { state: 'editable' },
            'pricing':    { state: 'editable' },
            'stock':      { state: 'editable' },
            'delivery':   { state: 'editable' },
            'returns':    { state: 'editable' },
            'ip':         { state: 'editable' },
            'accounts':   { state: 'editable' },
            'privacy':    { state: 'editable' },
            'liability':  { state: 'editable', requiredPhrases: ['Consumer Guarantees Act 1993', 'Fair Trading Act 1986'] },
            'changes':    { state: 'editable' },
            'law':        { state: 'editable' },
            'contact':    { state: 'locked', reason: REASON.FACTS },
        },
    },

    privacy: {
        title: 'Privacy Policy',
        path: 'html/privacy.html',
        url: '/privacy',
        sections: {
            // NB: the Act is cited in the page hero and in §4's heading, both of which sit
            // outside every editable extent — so the phrase is pinned on the two body
            // sections that actually carry it, not on this one.
            'who':           { state: 'editable' },
            'what':          { state: 'editable' },
            'why':           { state: 'editable' },
            'legal-basis':   { state: 'editable' },
            'who-we-share':  { state: 'locked', reason: REASON.STRUCTURE },
            'cookies':       { state: 'locked', reason: REASON.STRUCTURE },
            'security':      { state: 'editable', requiredPhrases: ['Office of the Privacy Commissioner', 'Privacy Act 2020'] },
            'retention':     { state: 'editable' },
            'rights':        { state: 'editable', requiredPhrases: ['Privacy Act 2020', 'Office of the Privacy Commissioner'] },
            'children':      { state: 'editable' },
            'changes':       { state: 'editable' },
            'contact':       { state: 'locked', reason: REASON.FACTS },
        },
    },

    returns: {
        title: 'Refund & Return Policy',
        path: 'html/returns.html',
        url: '/returns',
        sections: {
            'snapshot':       { state: 'editable' },
            'cga':            { state: 'editable', requiredPhrases: ['Consumer Guarantees Act 1993', 'in trade'] },
            'change-of-mind': { state: 'editable' },
            'opened':         { state: 'editable' },
            'wrong-item':     { state: 'editable' },
            'lost':           { state: 'editable' },
            'business':       { state: 'editable' },
            'how-refunds':    { state: 'editable' },
            // tests/reappeal-disclaimers-jul2026.test.js pins the processing SLA.
            'refund-window':  { state: 'editable', requiredPhrases: ['3–5 business days', 'Consumer Guarantees Act 1993'] },
            'address':        { state: 'locked', reason: REASON.FACTS },
            'contact':        { state: 'locked', reason: REASON.FACTS },
        },
    },

    shipping: {
        title: 'Shipping & Delivery',
        path: 'html/shipping.html',
        url: '/shipping',
        sections: {
            'snapshot':            { state: 'editable' },
            'rates':               { state: 'locked', reason: REASON.STRUCTURE },
            'handling-vs-transit': { state: 'editable' },
            'splits':              { state: 'editable' },
            'tracking':            { state: 'editable' },
            'cutoffs':             { state: 'editable' },
            'international':       { state: 'editable' },
            'problems':            { state: 'editable' },
            'contact':             { state: 'locked', reason: REASON.FACTS },
        },
    },

    faq: {
        title: 'FAQ',
        path: 'html/faq.html',
        url: '/faq',
        sections: {
            'cartridges':      { state: 'locked', reason: REASON.FAQ },
            'orders-shipping': { state: 'locked', reason: REASON.FAQ },
            'returns':         { state: 'locked', reason: REASON.FAQ },
            'account':         { state: 'locked', reason: REASON.FAQ },
            'contact':         { state: 'locked', reason: REASON.FACTS },
        },
    },

    'genuine-vs-compatible': {
        title: 'Genuine vs Compatible',
        path: 'html/genuine-vs-compatible.html',
        url: '/genuine-vs-compatible',
        sections: {
            'summary':    { state: 'editable' },
            'genuine':    { state: 'editable' },
            'compatible': { state: 'editable' },
            'labelling':  { state: 'editable' },
            // Both sentences were supplied by legal for the Google Ads re-appeal and
            // are matched verbatim by tests/genuine-vs-compatible-warranty.test.js.
            'warranty':   {
                state: 'editable',
                requiredPhrases: [
                    'Compatible cartridges from us are covered by our 30-day satisfaction guarantee, '
                    + 'and your statutory rights under the New Zealand Consumer Guarantees Act 1993 '
                    + 'apply to everything we sell.',
                    'If you have questions about your printer\'s manufacturer warranty, check the '
                    + 'manufacturer\'s warranty terms.',
                ],
            },
            'choosing':   { state: 'editable' },
            'help':       { state: 'locked', reason: REASON.FACTS },
        },
    },
};

/** Doc slugs in the order the admin index lists them. */
const PAGE_COPY_DOC_ORDER = [
    'about', 'returns', 'shipping', 'terms', 'privacy', 'genuine-vs-compatible', 'faq',
];

/** The manifest entry for one doc, or null. */
function getDoc(slug) {
    return Object.prototype.hasOwnProperty.call(PAGE_COPY_DOCS, slug) ? PAGE_COPY_DOCS[slug] : null;
}

/**
 * The manifest entry for one section. Fails CLOSED: an unknown doc or an
 * unlisted section is reported locked, never editable.
 */
function getSectionRule(slug, sectionId) {
    const doc = getDoc(slug);
    if (!doc) return { state: 'locked', reason: 'Unknown page.' };
    const rule = Object.prototype.hasOwnProperty.call(doc.sections, sectionId)
        ? doc.sections[sectionId]
        : null;
    if (!rule) {
        return {
            state: 'locked',
            reason: 'This section is not listed in the Page Copy manifest, so it is read-only. '
                + 'A developer must add it to js/admin/utils/page-copy-regions.js deliberately.',
        };
    }
    return rule;
}

/** True when the manifest permits editing this section. */
function isSectionEditable(slug, sectionId) {
    return getSectionRule(slug, sectionId).state === 'editable';
}

/** The phrases that must survive an edit to this section (possibly empty). */
function requiredPhrases(slug, sectionId) {
    return getSectionRule(slug, sectionId).requiredPhrases || [];
}

export {
    PAGE_COPY_DOCS,
    PAGE_COPY_DOC_ORDER,
    REASON,
    getDoc,
    getSectionRule,
    isSectionEditable,
    requiredPhrases,
};
