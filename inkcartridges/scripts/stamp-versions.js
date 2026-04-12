#!/usr/bin/env node
/**
 * STAMP-VERSIONS.JS
 * =================
 * Content-hash cache busting for vanilla JS/CSS assets.
 *
 * Scans every HTML file and rewrites local /js/*.js and /css/*.css
 * references to include ?v=<hash>, where <hash> is an 8-char md5 of
 * the referenced file's current contents. When a file's contents
 * change, its hash changes, and browsers fetch the new version
 * instead of serving stale cache.
 *
 * Runs as Vercel's buildCommand so deployed HTML is stamped but
 * committed HTML stays pristine in git.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', 'scripts', 'backend']);

function hashFile(filePath) {
    try {
        const buf = fs.readFileSync(filePath);
        return crypto.createHash('md5').update(buf).digest('hex').slice(0, 8);
    } catch {
        return null;
    }
}

function findHtmlFiles(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) {
                findHtmlFiles(path.join(dir, entry.name), acc);
            }
        } else if (entry.name.endsWith('.html')) {
            acc.push(path.join(dir, entry.name));
        }
    }
    return acc;
}

const hashCache = new Map();
function getHash(urlPath) {
    if (hashCache.has(urlPath)) return hashCache.get(urlPath);
    const filePath = path.join(ROOT, urlPath);
    const hash = hashFile(filePath);
    hashCache.set(urlPath, hash);
    return hash;
}

// Match src="/js/foo.js" or href="/css/bar.css", preserving or replacing ?v=...
const ASSET_REGEX = /\b(src|href)="(\/(?:js|css)\/[^"?#]+\.(?:js|css))(\?[^"]*)?"/g;

const htmlFiles = findHtmlFiles(ROOT);
let filesUpdated = 0;
let refsUpdated = 0;

for (const htmlFile of htmlFiles) {
    const original = fs.readFileSync(htmlFile, 'utf8');
    let refsInThisFile = 0;

    const updated = original.replace(ASSET_REGEX, (match, attr, urlPath) => {
        const hash = getHash(urlPath);
        if (!hash) return match;
        refsInThisFile++;
        return `${attr}="${urlPath}?v=${hash}"`;
    });

    if (updated !== original) {
        fs.writeFileSync(htmlFile, updated);
        filesUpdated++;
        refsUpdated += refsInThisFile;
    }
}

console.log(`[stamp-versions] Stamped ${refsUpdated} asset refs across ${filesUpdated} HTML files.`);
