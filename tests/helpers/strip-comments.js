'use strict';

/**
 * stripComments — remove JS comments from source before a regression-guard
 * regex looks at it.
 * =============================================================================
 *
 * WHY THIS FILE EXISTS (ERR-253, 2026-09-12)
 * -----------------------------------------
 * Forty-six test files had each grown their own copy of this, and every copy
 * was the same two-line regex in the same order:
 *
 *     src.replace(BLOCK_COMMENT_RE, '')    <- block comments FIRST
 *        .replace(LINE_COMMENT_RE, '')     <- then line comments
 *
 * (written out with real regex literals in every copy; they are named here
 *  because a block comment cannot quote the characters that end a block
 *  comment, which is itself a small demonstration of the problem)
 *
 * That is wrong, and it fails silently in the worst possible direction. A LINE
 * comment that happens to contain the two characters `/` and `*` — which is
 * every time anyone writes a path like `/api/search/` + a star in a `//`
 * comment —
 * opens a block comment as far as the first regex is concerned, and everything
 * up to the next block-comment terminator anywhere in the file is deleted.
 * Not flagged. Deleted.
 *
 * MEASURED, at HEAD, before the change that found it:
 *
 *     search.js             15,059 characters of live code deleted
 *     security.js            2,465
 *     products.js            1,805
 *     shop-page.js           1,200
 *     main.js                1,080
 *     order-detail-page.js     440
 *     api.js / traffic-tracker.js / product-detail-page.js   ~200 combined
 *     ────────────────────────────
 *     22,251 characters, across 35 test files
 *
 * ***AN ASSERTION CANNOT FAIL OVER CODE THAT IS NOT IN THE STRING IT IS
 * READING.*** A `doesNotMatch` over a deleted region passes by construction,
 * which means several of this repo's "X is not allowed anywhere" guards —
 * including the XSS escaping guards over `security.js` — were green over code
 * they had never seen. That is the same family as ERR-237's negative control
 * that could never fail, and as ERR-220's presence check that asked about the
 * wrong field: a test whose failure mode is invisible is not a test.
 *
 * HOW THIS ONE WORKS
 * ------------------
 * One left-to-right pass, so a construct is only ever interpreted in the state
 * it is actually in:
 *
 *   - a line comment starts ONLY when not already inside a string or a block
 *     comment, so `'https://x'` survives and a starred path inside a line
 *     comment closes at the newline like it should.
 *   - a block comment starts ONLY when not inside a string or a line comment.
 *   - quotes and backticks are tracked, with backslash escapes honoured, so a
 *     URL or a glob in a string is never mistaken for a comment.
 *
 * VERIFIED NOT TO OVER-DELETE: run against all 188 files under
 * `inkcartridges/js`, this function's output is never SHORTER than the naive
 * version's — i.e. it removes strictly less, never more. That is the positive
 * control for the one thing a single-pass scanner could plausibly get wrong (an
 * unescaped slash inside a regex character class), and there is no such
 * construct in this codebase today. `tests/strip-comments-helper.test.js`
 * re-runs that check so it cannot quietly become false.
 *
 * TEMPLATE-LITERAL INTERPOLATIONS ARE CODE, AND ARE SCANNED AS CODE. The first
 * version of this treated a backtick literal as opaque from end to end, which
 * is the safe direction — it can only preserve source, never delete it — but it
 * is not the correct one, and the repo proved it within a minute:
 * `order-detail-page.js` builds its whole items list inside one template
 * literal, and eleven lines of genuine `//` comments live inside its
 * `${items.map(...)}` callback. One of them quotes a retired regex to explain
 * why it is retired, and `cart-line-source-aug2026` has a repo-wide fence that
 * bans exactly that regex from shipping code. Keeping the comment made a
 * comment look like a violation.
 *
 * So `${` switches back to code mode and the matching `}` switches back to
 * string mode, tracked by brace depth. Nested literals and nested objects both
 * work because the two modes are a stack, not a flag.
 */
function stripComments(src) {
    if (typeof src !== 'string') return '';
    let out = '';
    let i = 0;
    const n = src.length;
    // Template literals we are inside of, and the brace depth within the
    // interpolation that will end each one.
    const stack = [];
    const braces = [];
    while (i < n) {
        const c = src[i];
        const d = src[i + 1];
        if (c === '/' && d === '/') {
            while (i < n && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && d === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            out += src[i++];
            while (i < n) {
                if (src[i] === '\\') {
                    out += src[i] + (src[i + 1] || '');
                    i += 2;
                    continue;
                }
                // A `${` inside a template literal ends the string and starts
                // code again. Hand the interpolation back to the main loop by
                // stacking the literal, so comments inside it are stripped.
                if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
                    out += '${';
                    i += 2;
                    stack.push(quote);
                    braces.push(0);
                    break;
                }
                if (src[i] === quote) {
                    out += src[i++];
                    break;
                }
                out += src[i++];
            }
            continue;
        }
        // Inside an interpolation, brace depth decides when the literal resumes.
        if (stack.length) {
            if (c === '{') braces[braces.length - 1]++;
            else if (c === '}') {
                if (braces[braces.length - 1] === 0) {
                    const quote = stack.pop();
                    braces.pop();
                    out += src[i++];
                    // Resume the literal we left.
                    while (i < n) {
                        if (src[i] === '\\') {
                            out += src[i] + (src[i + 1] || '');
                            i += 2;
                            continue;
                        }
                        if (src[i] === '$' && src[i + 1] === '{') {
                            out += '${';
                            i += 2;
                            stack.push(quote);
                            braces.push(0);
                            break;
                        }
                        if (src[i] === quote) { out += src[i++]; break; }
                        out += src[i++];
                    }
                    continue;
                }
                braces[braces.length - 1]--;
            }
        }
        out += src[i++];
    }
    return out;
}

module.exports = stripComments;
module.exports.stripComments = stripComments;
