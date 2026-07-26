#!/usr/bin/env node
/**
 * CANONICALISE-PAGE-COPY.MJS
 * ==========================
 * Rewrite the EDITABLE regions of the content pages into the canonical form
 * defined by js/admin/utils/page-copy-model.js.
 *
 *   node inkcartridges/scripts/canonicalise-page-copy.mjs           # rewrite
 *   node inkcartridges/scripts/canonicalise-page-copy.mjs --check   # report only
 *
 * WHY THIS EXISTS
 * ---------------
 * The admin Page Copy editor writes a section back by serializing the block
 * model, not by echoing the original bytes. If the file on disk is not already
 * in canonical form, the owner's first edit produces a diff containing every
 * whitespace difference in the section as well as the sentence they changed —
 * unreviewable, and indistinguishable from a mangling bug.
 *
 * So the reflow is landed ONCE, deliberately, as a pure-formatting commit that
 * can be reviewed as such. Afterwards every real edit is a minimal diff.
 *
 * WHAT IT CHANGES: whitespace only. Blocks go one per line at the section's
 * indent, list items one step deeper, and runs of whitespace inside a block
 * collapse to single spaces. Text is otherwise byte-identical — entities are
 * never decoded, attributes keep their source order.
 *
 * WHAT IT WILL NOT TOUCH:
 *   - <head>, meta, canonical/hreflang, JSON-LD, header, nav, breadcrumb, footer
 *   - every <script src="/js/*.js?v=…"> line (pinned by tests/asset-cache-tokens.js;
 *     stamp-versions.js rewrites those tokens at build time)
 *   - each <section> open tag, its id, and its <h2> — buildTOC() in js/legal-page.js
 *     derives the table of contents from those, and the ids are public deep links
 *   - LOCKED regions, which stay byte-exact. They are never written by the editor,
 *     so reflowing them would be diff noise over compliance-pinned markup for no gain.
 *
 * Verified by tests/page-copy-editor-jul2026.test.js, which re-runs this in
 * --check mode and fails if any editable region has drifted out of canonical form.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    findSections,
    regionSource,
    parseRegion,
    serializeRegion,
    spliceRegion,
    collectBindings,
    blocksText,
} from '../js/admin/utils/page-copy-model.js';

import {
    PAGE_COPY_DOC_ORDER,
    getDoc,
    isSectionEditable,
} from '../js/admin/utils/page-copy-regions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(HERE, '..');

const squeeze = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Canonicalise one document.
 * @returns {{slug, changed: string[], skipped: string[], unsafe: string[], before: string, after: string}}
 */
export function canonicaliseDoc(slug, html) {
    const doc = getDoc(slug);
    if (!doc) throw new Error(`canonicalise-page-copy: unknown doc "${slug}"`);

    const changed = [];
    const skipped = [];
    const unsafe = [];
    let out = html;

    // Re-find sections each pass: splicing shifts every later offset.
    for (const { id } of findSections(html)) {
        if (!isSectionEditable(slug, id)) { skipped.push(id); continue; }

        const section = findSections(out).find(s => s.id === id);
        if (!section) { skipped.push(id); continue; }

        const src = regionSource(out, section);
        const blocks = parseRegion(src);
        if (blocks === null) { skipped.push(id); continue; }

        const canonical = serializeRegion(blocks, section.indent);
        const spliced = spliceRegion(out, id, blocks);

        // Refuse to write a change that alters what a reader sees or which
        // facts are bound. This script is meant to be provably text-preserving;
        // if that ever stops being true, stop rather than "mostly" reformat.
        const after = parseRegion(regionSource(spliced, findSections(spliced).find(s => s.id === id)));
        if (after === null
            || squeeze(blocksText(blocks)) !== squeeze(blocksText(after))
            || collectBindings(blocks).join('|') !== collectBindings(after).join('|')) {
            unsafe.push(id);
            continue;
        }

        if (canonical !== src.replace(/^\n/, '').replace(/\n[ \t]*$/, '')) changed.push(id);
        out = spliced;
    }

    return { slug, changed, skipped, unsafe, before: html, after: out };
}

function main() {
    const checkOnly = process.argv.includes('--check');
    let drifted = 0;
    let unsafeTotal = 0;

    for (const slug of PAGE_COPY_DOC_ORDER) {
        const doc = getDoc(slug);
        const file = path.join(SITE_ROOT, doc.path);
        const html = fs.readFileSync(file, 'utf8');
        const result = canonicaliseDoc(slug, html);

        unsafeTotal += result.unsafe.length;
        if (result.unsafe.length) {
            console.error(`  !! ${doc.path}: REFUSED (would change prose or bindings): ${result.unsafe.join(', ')}`);
        }

        if (result.after === html) {
            console.log(`  = ${doc.path} — already canonical (${result.skipped.length} locked/skipped)`);
            continue;
        }

        drifted += result.changed.length;
        const delta = result.after.length - html.length;
        console.log(`  ${checkOnly ? '~' : '→'} ${doc.path} — ${result.changed.length} section(s): `
            + `${result.changed.join(', ')} (${delta >= 0 ? '+' : ''}${delta} bytes)`);
        if (!checkOnly) fs.writeFileSync(file, result.after, 'utf8');
    }

    if (unsafeTotal) {
        console.error(`\nFAILED: ${unsafeTotal} section(s) refused. Nothing about those was written.`);
        process.exit(2);
    }
    if (checkOnly && drifted) {
        console.error(`\n${drifted} section(s) are not in canonical form. `
            + `Run: node inkcartridges/scripts/canonicalise-page-copy.mjs`);
        process.exit(1);
    }
    console.log(checkOnly ? '\nAll editable regions are canonical.' : '\nDone.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main();
}
