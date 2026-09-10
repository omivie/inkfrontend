#!/usr/bin/env node
/**
 * BUNDLE-BACKEND-OUTBOX.MJS
 * =========================
 * Concatenate the undelivered backend documents into ONE file you can attach.
 *
 *   npm run bundle:backend              # the priority set below
 *   npm run bundle:backend -- --all     # every file in backend-docs/outbox/
 *   npm run bundle:backend -- --out /tmp/x.md
 *
 * WHY A GENERATOR AND NOT A COMMITTED COPY
 * ----------------------------------------
 * A checked-in concatenation duplicates ~68KB into git and goes stale the moment
 * one source document is edited — which is the exact problem the backend-docs/
 * move was made to end. So the generator is committed and the output is not:
 * `backend-docs/bundles/` is gitignored.
 *
 * WHY THE ORDER IS HARD-CODED
 * ---------------------------
 * Alphabetical would open with the admin-only test product and bury the index.
 * The reader is a person deciding what to do first, so the order is the priority
 * order, and each entry carries the reason it sits where it does.
 *
 * FAIL LOUDLY, NEVER SHIP A SHORT BUNDLE
 * --------------------------------------
 * If a named document is missing from outbox/ (delivered and moved to sent/, or
 * renamed), this EXITS NON-ZERO and names it. A bundle that quietly ships six of
 * seven is worse than no bundle: the missing one is invisible at the far end.
 * Exit codes follow the probes — 0 ok, 1 a document is missing, 2 setup error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTBOX = path.join(ROOT, 'backend-docs', 'outbox');

const C = { dim: '\x1b[2m', cyan: '\x1b[36m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', off: '\x1b[0m' };

/**
 * The undelivered batch, in the order a reader should meet it.
 * Keep the `why` short — it is printed in the bundle's own contents list.
 */
const PRIORITY = [
    ['BACKEND-ASKS-INDEX-sep2026.md',
     'Read first. The cover note, and the only written record of the ERR-232 analytics-RPC 403 outage.'],
    ['printer-canonicals-backend-brief-sep2026.md',
     'Unblocks THEM: carries the green light to run migration 132, which they are holding on our word.'],
    ['fe-backend-asks-sep2026.md',
     'The money items — delivery_type not stored, six months of empty search_analytics, and BF-021.'],
    ['security-hardening-round2-FE-response-sep2026.md',
     'Answers their round-2 hand-off, including one item they certified as working that is broken.'],
    ['supplier-freight-backend-brief-sep2026.md',
     'ERR-241 — supplier freight on order profit; the Dashboard and the modal disagree until this lands.'],
    ['admin-only-test-product-backend-brief-sep2026.md',
     'ERR-234 — carries a sequencing constraint to read BEFORE deploying.'],
    ['mobile-ux-and-remaining-gaps-FE-response-sep2026.md',
     'The phone pass — and the warning that two of the three fixes in their own report cannot work as written.'],
];

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const outFlag = argv.indexOf('--out');
const today = new Date().toISOString().slice(0, 10);

function die(code, msg) {
    console.error(`${C.red}${msg}${C.off}`);
    process.exit(code);
}

if (!fs.existsSync(OUTBOX)) die(2, `backend-docs/outbox/ not found at ${OUTBOX}`);

let entries;
if (ALL) {
    const known = new Map(PRIORITY);
    const onDisk = fs.readdirSync(OUTBOX).filter((f) => f.endsWith('.md')).sort();
    // Priority set first, in order; then everything else alphabetically.
    const rest = onDisk.filter((f) => !known.has(f));
    entries = [...PRIORITY.filter(([f]) => onDisk.includes(f)), ...rest.map((f) => [f, ''])];
} else {
    entries = PRIORITY;
}

const missing = entries.map(([f]) => f).filter((f) => !fs.existsSync(path.join(OUTBOX, f)));

console.log(`${C.cyan}MODE: READ-ONLY${C.off}  (reads backend-docs/outbox/, writes one file, changes nothing else)`);
console.log(`${C.dim}Set: ${ALL ? 'ALL of outbox/' : 'the undelivered priority batch'} — ${entries.length} document(s)${C.off}\n`);

if (missing.length) {
    console.error(`${C.red}REFUSING TO BUNDLE — ${missing.length} document(s) named in the priority set are not in outbox/:${C.off}`);
    for (const m of missing) console.error(`  - ${m}`);
    console.error(`\n${C.yellow}If one was delivered, it has moved to backend-docs/sent/ — remove it from PRIORITY in this\nscript rather than letting the bundle ship short. A missing document is invisible at the far end.${C.off}`);
    process.exit(1);
}

const outPath = outFlag !== -1 && argv[outFlag + 1]
    ? path.resolve(argv[outFlag + 1])
    : path.join(ROOT, 'backend-docs', 'bundles', `backend-asks-${today}.md`);

fs.mkdirSync(path.dirname(outPath), { recursive: true });

const parts = [];
parts.push(`# Backend asks — ${entries.length} documents, bundled ${today}`);
parts.push('');
parts.push('One file, so nothing is missed in the handover. Each document below is reproduced');
parts.push('verbatim under a separator naming its original filename — **reply citing the filename,');
parts.push('not this bundle**, so the thread stays attached to the document.');
parts.push('');
parts.push('Ordered by what to do first, not alphabetically:');
parts.push('');
for (const [i, [file, why]] of entries.entries()) {
    parts.push(`${i + 1}. **\`${file}\`**${why ? ` — ${why}` : ''}`);
}
parts.push('');
parts.push('Every number in these documents was measured against production. Where a claim of');
parts.push('yours did not reproduce, the document says so and shows the measurement.');
parts.push('');

for (const [file] of entries) {
    const body = fs.readFileSync(path.join(OUTBOX, file), 'utf8').replace(/\s+$/, '');
    parts.push('');
    parts.push('---');
    parts.push('');
    parts.push(`<!-- ==================== ${file} ==================== -->`);
    parts.push('');
    parts.push(`> **Source document: \`${file}\`**`);
    parts.push('');
    parts.push(body);
    parts.push('');
}

const out = parts.join('\n') + '\n';
fs.writeFileSync(outPath, out, 'utf8');

const rel = path.relative(ROOT, outPath);
console.log(`${C.green}Wrote${C.off} ${rel}  ${C.dim}(${out.length.toLocaleString()} bytes, ${entries.length} documents)${C.off}`);
for (const [file] of entries) {
    const n = fs.statSync(path.join(OUTBOX, file)).size;
    console.log(`  ${C.dim}${String(n).padStart(6)}${C.off}  ${file}`);
}
process.exit(0);
