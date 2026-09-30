/**
 * The focus cards name labs statically, and the capability brief names them in
 * its numbered list. Those are two copies of one fact, kept in two files, read
 * by two different consumers -- the page by a visitor, the brief by the
 * assistant. This test refuses to let them drift.
 *
 * It checks the card side against the brief rather than against GitHub on
 * purpose: the brief is already cross-checked against the live topic query
 * before every publish, so anchoring here to the brief makes the chain
 * page -> brief -> GitHub rather than two independent claims about GitHub.
 *
 *   node dev/test-focus.mjs
 */
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const brief = fs.readFileSync(new URL('../capability-brief.md', import.meta.url), 'utf8');

let failed = 0;
const check = (ok, label, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || !detail ? '' : '\n        ' + detail));
  if (!ok) failed++;
};

// ---------------------------------------------------------------- the page side
const focusStart = html.indexOf('<section id="focus">');
const focusEnd = html.indexOf('</section>', focusStart);
check(focusStart > -1 && focusEnd > focusStart, 'the focus section exists');
const focus = html.slice(focusStart, focusEnd);

const cardLabs = [...focus.matchAll(/data-lab="([a-z0-9-]+)"/g)].map((m) => m[1]);
const hrefs = [...focus.matchAll(/class="proof-lab"[^>]*href="([^"]+)"/g)].map((m) => m[1]);

// ---------------------------------------------------------------- the brief side
const briefLabs = [...brief.matchAll(/^\d+\. \*\*([a-z0-9-]+)\*\*/gm)].map((m) => m[1]);

// ---------------------------------------------------------------------- checks
check(briefLabs.length > 0, 'the brief lists labs', 'found none -- has the numbered list changed shape?');

const placedSet = new Set(cardLabs);
const briefSet = new Set(briefLabs);

const missing = briefLabs.filter((n) => !placedSet.has(n));
check(missing.length === 0, 'every lab in the brief is placed under a specialty', missing.join(', '));

const unknown = cardLabs.filter((n) => !briefSet.has(n));
check(unknown.length === 0, 'every lab on a card is one the brief knows about', unknown.join(', '));

const dupes = cardLabs.filter((n, i) => cardLabs.indexOf(n) !== i);
check(dupes.length === 0, 'no lab is placed under two specialties', [...new Set(dupes)].join(', '));

const badHref = hrefs.filter((h, i) => h !== 'https://github.com/zuqdah/' + cardLabs[i]);
check(badHref.length === 0, 'every proof link points at its own repository', badHref.join(', '));
check(hrefs.length === cardLabs.length, 'every placed lab has a link', hrefs.length + ' links for ' + cardLabs.length + ' labs');

const cards = (focus.match(/class="card has-proof"/g) || []).length;
check(cards === 6, 'six specialty cards', 'found ' + cards);

const heads = (focus.match(/class="proof-head"/g) || []).length;
check(heads === cards, 'every card has a Proven-in block', heads + ' blocks for ' + cards + ' cards');

// A stale claim that used to live in the labs section. It said an analytics lab
// was "In build" after the Fabric and Databricks labs had been published, which
// is the kind of thing a hiring manager notices and the author never does.
check(!/class="status">In build</.test(html), 'no "In build" card remains on the page');

// The page must never state a lab count; the feed derives it live.
const counts = html.match(/\b(?:fifteen|sixteen|seventeen|eighteen|1[5-9])\s+(?:published\s+)?labs\b/i);
check(!counts, 'no hardcoded lab count in the page', counts && counts[0]);

console.log('\n' + (cardLabs.length) + ' labs placed across ' + cards + ' cards; brief lists ' + briefLabs.length + '.');
console.log(failed ? failed + ' check(s) FAILED' : 'all focus checks passed');
process.exit(failed ? 1 : 0);
