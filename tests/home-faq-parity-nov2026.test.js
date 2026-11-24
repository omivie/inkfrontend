'use strict';
/* FE-4b (Nov 2026): the home FAQPage JSON-LD must describe exactly the FAQ a
 * visitor sees. Before this, 4 of its 5 Q&A appeared nowhere on the page. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();

for (const rel of ['inkcartridges/index.html', 'inkcartridges/html/index.html']) {
    test(`${rel}: FAQPage Q&A are byte-identical to the visible FAQ, same order`, () => {
        const html = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
        const list = html.slice(html.indexOf('class="faq-list"'));
        const visible = [...list.slice(0, list.indexOf('</section>'))
            .matchAll(/<summary class="faq-question">([\s\S]*?)<\/summary>\s*<div class="faq-answer">\s*<p>([\s\S]*?)<\/p>/g)]
            .map((m) => [decode(m[1]), decode(m[2])]);
        const faq = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
            .map((m) => JSON.parse(m[1])).filter((d) => d['@type'] === 'FAQPage');
        assert.equal(faq.length, 1);
        const marked = faq[0].mainEntity.map((q) => [q.name, q.acceptedAnswer.text]);
        assert.ok(visible.length > 0);
        assert.deepEqual(marked, visible);
    });
}
