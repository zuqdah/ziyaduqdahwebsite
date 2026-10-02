/**
 * Has anything drifted apart since the last time somebody looked?
 *
 * The same fact about this portfolio is stated in five places -- the GitHub
 * topic, the capability brief, the focus cards on the page, the deployed copy
 * of that page, and the GitHub profile README -- and they are kept in step by
 * hand. Every time they have fallen out of step it was found by accident:
 * labs 12 and 13 missing from the brief for a month, the profile README six
 * labs behind with a count nobody updated, an "In build" card describing work
 * that had shipped, a push the server had not pulled.
 *
 * This reads all of them and compares. It changes nothing.
 *
 *   node dev/drift-check.mjs
 *
 * Exit 0: everything agrees. Exit 1: something has drifted. Exit 2: nothing is
 * known to have drifted but a check could not be made -- a network call failed,
 * a repository was missing. That is deliberately not a pass: a check that could
 * not run reports nothing, and nothing looks exactly like clean.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const ROOT = path.resolve(SITE, '..');
const PROFILE = path.join(ROOT, 'zuqdah-profile');
const LABS = path.join(ROOT, 'labs');

const USER = 'zuqdah';
const TOPIC = 'portfolio-lab';
const LIVE_URL = 'https://ziyaduqdah.com/';
const PROFILE_RAW = 'https://raw.githubusercontent.com/zuqdah/zuqdah/main/README.md';
const EXPECTED_IDENTITY = 'Ziyad Uqdah <ziyad@ziyaduqdah.com>';
// The positioning line that was retired on 2026-09-30. It must not come back
// through a restored file, an old branch, or a copy-paste from an old README.
const RETIRED_LINE = /cloud\s*(?:&amp;|&|and)\s*infrastructure architecture/i;

// A stated number of labs. Number words and digits only, and the gap must stay
// on one line: the first version used [a-z]+ for the number and \s+ for the
// gap, so "...in these repos" on one line followed by "Labs, each built..." on
// the next read as a count of "repos labs" and failed a README that states none.
const NUMBER = '(?:\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)(?:-(?:one|two|three|four|five|six|seven|eight|nine))?';
const LAB_COUNT = new RegExp('\\b' + NUMBER + '[ \\t]+(?:published[ \\t]+|public[ \\t]+)?labs\\b', 'i');

// --------------------------------------------------------------------- report
const results = [];
let section = '';
const start = (name) => { section = name; };
const record = (state, label, detail) => results.push({ section, state, label, detail });
const pass = (label) => record('ok', label);
const drift = (label, detail) => record('drift', label, detail);
const unknown = (label, detail) => record('unknown', label, detail);
const check = (ok, label, detail) => (ok ? pass(label) : drift(label, detail));

// -------------------------------------------------------------------- helpers
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const lf = (s) => s.replace(/\r\n/g, '\n');

function git(repo, ...args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 1 << 26,
    }).replace(/\s+$/, '');
  } catch {
    return null;
  }
}

async function get(url, asJson) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'drift-check', Accept: asJson ? 'application/vnd.github+json' : '*/*' } });
    if (!res.ok) return { error: 'HTTP ' + res.status };
    return { body: asJson ? await res.json() : await res.text() };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

function numberWord(n) {
  const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];
  if (n < 20) return ones[n];
  return tens[Math.floor(n / 10)] + (n % 10 ? '-' + ones[n % 10] : '');
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const missingFrom = (a, b) => a.filter((x) => !b.includes(x));

// ------------------------------------------------------------------- sources
const brief = read(path.join(SITE, 'capability-brief.md'));
const html = read(path.join(SITE, 'index.html'));

const briefLabs = brief ? [...brief.matchAll(/^(\d+)\. \*\*([a-z0-9-]+)\*\*/gm)].map((m) => ({ n: Number(m[1]), name: m[2] })) : [];
const briefNames = briefLabs.map((l) => l.name);
const cardHeadings = html
  ? [...html.matchAll(/class="card has-proof">[\s\S]*?<h3>([^<]+)<\/h3>/g)].map((m) => m[1].replace(/&amp;/g, '&'))
  : [];

// ================================================ 0. the checker's own detectors
// Two of the checks below pass when a pattern finds nothing -- and a pattern
// that can never match also finds nothing. So before any of them is believed,
// each detector is shown text it must catch and text it must leave alone. This
// runs every time, because a detector broken by a later edit would otherwise
// report clean for as long as nobody looked.
start('The checker itself');
for (const [name, re, mustMatch, mustNot] of [
  ['lab-count detector', LAB_COUNT,
    ['Eleven labs, each built end to end', '17 published labs', 'The seventeen public labs', 'twenty-one labs so far'],
    ['What is in these repos\n\nLabs, each built end to end', 'the published labs appear on the site', 'both data-platform labs and the Databricks one']],
  ['retired-line detector', RETIRED_LINE,
    ['Cloud & Infrastructure Architecture', 'Cloud &amp; Infrastructure Architecture', 'senior cloud and infrastructure architecture roles'],
    ['infrastructure engineering, and cloud architecture', 'Cloud, Data Platforms & Analytics | DevOps', 'cloud and hybrid architecture']],
]) {
  const missed = mustMatch.filter((s) => !re.test(s));
  const caughtWrongly = mustNot.filter((s) => re.test(s));
  check(missed.length === 0, 'the ' + name + ' catches what it should', 'missed: ' + JSON.stringify(missed));
  check(caughtWrongly.length === 0, 'the ' + name + ' leaves innocent text alone', 'wrongly caught: ' + JSON.stringify(caughtWrongly));
}
check(numberWord(17) === 'seventeen' && numberWord(21) === 'twenty-one' && numberWord(9) === 'nine',
  'numbers are spelled the way the brief heading spells them', numberWord(17) + ', ' + numberWord(21));

// ============================================================ 1. local suites
start('Local test suites');
for (const [label, args] of [
  ['focus cards agree with the brief (test-focus)', ['dev/test-focus.mjs']],
  ['plain() behaves as declared (test-plain)', ['dev/test-plain.mjs']],
  ['the eval grader can still fail (eval --self-test)', ['dev/eval.mjs', '--self-test']],
]) {
  const run = spawnSync(process.execPath, args, { cwd: SITE, encoding: 'utf8' });
  if (run.error) unknown(label, 'could not run: ' + run.error.message);
  else check(run.status === 0, label, 'exited ' + run.status + '; run it directly to see which check failed');
}

// ================================================= 2. the brief vs the topic
start('Capability brief vs the live GitHub topic');
const repos = await get('https://api.github.com/users/' + USER + '/repos?per_page=100&sort=pushed', true);
let liveLabs = null;
if (repos.error || !Array.isArray(repos.body)) {
  unknown('fetched the published lab list from GitHub', repos.error || 'unexpected response shape');
} else {
  liveLabs = repos.body.filter((r) => !r.fork && !r.archived && Array.isArray(r.topics) && r.topics.includes(TOPIC));
  const liveNames = liveLabs.map((r) => r.name);
  pass('fetched the published lab list from GitHub (' + liveNames.length + ' labs)');

  check(missingFrom(liveNames, briefNames).length === 0, 'every published lab has an entry in the brief',
    'published but not in the brief, so the assistant cannot discuss it: ' + missingFrom(liveNames, briefNames).join(', '));
  check(missingFrom(briefNames, liveNames).length === 0, 'every brief entry is still a published lab',
    'in the brief but no longer published: ' + missingFrom(briefNames, liveNames).join(', '));

  const heading = '## The ' + numberWord(liveNames.length) + ' public labs';
  check(brief && brief.includes(heading), 'the brief heading states the right count', 'expected "' + heading + '"');

  const contiguous = briefLabs.every((l, i) => l.n === i + 1);
  check(contiguous, 'brief numbering is contiguous from 1', 'found ' + briefLabs.map((l) => l.n).join(','));

  const routes = brief ? (brief.split('## Where to point a reader first')[1] || '').split('\n## ')[0] : '';
  const unrouted = liveNames.filter((n) => !routes.includes(n));
  check(unrouted.length === 0, 'every lab is reachable from a routing line', 'not routed: ' + unrouted.join(', '));

  const undescribed = liveLabs.filter((r) => !r.description).map((r) => r.name);
  check(undescribed.length === 0, 'every lab has a description for its catalogue card', undescribed.join(', '));
}

// ===================================================== 3. the deployed page
start('Deployed site vs the repository');
git(SITE, 'fetch', '-q', 'origin');
const committed = git(SITE, 'show', 'origin/main:index.html');
const live = await get(LIVE_URL + '?drift=' + Date.now(), false);
if (live.error) {
  unknown('fetched the live page', live.error);
} else if (committed === null) {
  unknown('read index.html at origin/main', 'git show failed');
} else {
  const a = lf(live.body).replace(/\s+$/, '');
  const b = lf(committed).replace(/\s+$/, '');
  if (a === b) {
    pass('the live page is byte-identical to index.html at origin/main');
  } else {
    const la = a.split('\n');
    const lb = b.split('\n');
    let i = 0;
    while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
    drift('the live page is byte-identical to index.html at origin/main',
      'first difference at line ' + (i + 1) + ' -- most likely a push the server has not pulled (Plesk pull is manual)');
  }
  const liveCards = [...live.body.matchAll(/data-lab="([a-z0-9-]+)"/g)].map((m) => m[1]);
  check(sameSet(liveCards, briefNames), 'the live focus cards name exactly the labs in the brief',
    'live page places ' + liveCards.length + ', brief lists ' + briefNames.length);
  check(!RETIRED_LINE.test(live.body), 'the retired positioning line is not on the live page');
  check(!/class="status">In build</.test(live.body), 'no "In build" card on the live page');
}

// ================================================= 4. the published profile
start('GitHub profile README vs the brief and the page');
const profile = await get(PROFILE_RAW + '?drift=' + Date.now(), false);
if (profile.error) {
  unknown('fetched the published profile README', profile.error);
} else {
  const md = profile.body;
  const links = [...md.matchAll(/\[([a-z0-9-]+)\]\(https:\/\/github\.com\/zuqdah\/([a-z0-9-]+)\)/g)].map((m) => ({ text: m[1], target: m[2] }));
  const linked = links.map((l) => l.target);
  check(missingFrom(briefNames, linked).length === 0, 'the profile links every lab in the brief',
    'missing from the profile: ' + missingFrom(briefNames, linked).join(', '));
  check(missingFrom(linked, briefNames).length === 0, 'the profile links nothing the brief does not know',
    missingFrom(linked, briefNames).join(', '));
  check(new Set(linked).size === linked.length, 'no lab is linked twice on the profile');
  const mislabelled = links.filter((l) => l.text !== l.target).map((l) => l.text);
  check(mislabelled.length === 0, 'every profile link text matches its target', mislabelled.join(', '));

  const groups = [...md.matchAll(/^\*\*([^*]+)\*\*\s*$/gm)].map((m) => m[1]);
  check(JSON.stringify(groups) === JSON.stringify(cardHeadings), 'profile groups match the six site cards, in order',
    'profile: ' + groups.join(' / ') + '  |  site: ' + cardHeadings.join(' / '));

  const count = md.match(LAB_COUNT);
  check(!count, 'the profile states no lab count', count && JSON.stringify(count[0]));
  check(!RETIRED_LINE.test(md), 'the retired positioning line is not on the profile');
}

// ========================================================= 5. repo hygiene
start('Repositories: clean, pushed, and committed under one identity');
const repoDirs = [SITE, PROFILE];
if (fs.existsSync(LABS)) {
  for (const d of fs.readdirSync(LABS)) {
    const p = path.join(LABS, d);
    if (fs.existsSync(path.join(p, '.git'))) repoDirs.push(p);
  }
} else {
  unknown('found the labs directory', LABS + ' does not exist');
}

const dirty = [];
const unpushed = [];
const unreadable = [];
const foreign = [];
let commits = 0;

for (const repo of repoDirs) {
  const name = path.basename(repo);
  if (git(repo, 'rev-parse', 'HEAD') === null) { unreadable.push(name); continue; }
  if (git(repo, 'status', '--porcelain')) dirty.push(name);
  git(repo, 'fetch', '-q', 'origin');
  if (git(repo, 'rev-parse', 'HEAD') !== git(repo, 'rev-parse', 'origin/main')) unpushed.push(name);
  commits += Number(git(repo, 'rev-list', '--all', '--count') || 0);
  // Author AND committer. Checking the author alone once let eight commits made
  // through the GitHub web UI read as clean while the committer was someone else.
  const ids = ((git(repo, 'log', '--all', '--format=%an <%ae>%n%cn <%ce>') || '').split('\n')).filter(Boolean);
  for (const id of new Set(ids)) if (id !== EXPECTED_IDENTITY) foreign.push(name + ': ' + id);
}

check(unreadable.length === 0, 'every repository is readable from here', unreadable.join(', '));
check(dirty.length === 0, 'no repository has uncommitted changes', dirty.join(', '));
check(unpushed.length === 0, 'every repository matches its remote', unpushed.join(', '));
check(foreign.length === 0, 'every commit is authored and committed as ' + EXPECTED_IDENTITY + ' (' + commits + ' commits)',
  foreign.join('; '));
if (liveLabs) {
  const cloned = repoDirs.map((r) => path.basename(r));
  const notCloned = liveLabs.map((r) => r.name).filter((n) => !cloned.includes(n));
  check(notCloned.length === 0, 'every published lab has a local clone that was checked', notCloned.join(', '));
}

// --------------------------------------------------------------------- output
let current = '';
for (const r of results) {
  if (r.section !== current) { current = r.section; console.log('\n' + current); }
  const tag = r.state === 'ok' ? 'ok     ' : r.state === 'drift' ? 'DRIFT  ' : 'UNKNOWN';
  console.log('  ' + tag + ' ' + r.label + (r.state !== 'ok' && r.detail ? '\n          ' + r.detail : ''));
}

const drifted = results.filter((r) => r.state === 'drift').length;
const unknowns = results.filter((r) => r.state === 'unknown').length;
const okay = results.filter((r) => r.state === 'ok').length;
console.log('\n' + '-'.repeat(72));
console.log('  ' + okay + ' agree; ' + drifted + ' drifted; ' + unknowns + ' could not be checked.');
if (drifted) console.log('  Something has drifted. Nothing was changed.');
else if (unknowns) console.log('  Nothing is known to have drifted, but that is not the same as clean.');
else console.log('  Everything agrees.');
process.exit(drifted ? 1 : unknowns ? 2 : 0);
