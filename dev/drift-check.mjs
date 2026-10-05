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
import os from 'os';
import path from 'path';
import { execFileSync, execSync, spawnSync } from 'child_process';
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

// ------------------------------------------------------------ money and seats
// Added 2026-10-05, after a lab that documented itself as costing nothing was
// found to have billed 5.81 USD: seven Azure DevOps service principals kept
// Basic licences for ten days behind a teardown that reported itself verified.
// Nothing looked at the bill, at the seat count, or at a nightly cleanup job
// that had been red every night since the lab was published.
const LAB_SUBSCRIPTION = 'Ziyad Uqdah';        // matched by exact name; no other subscription is ever queried
const ADO_ORG = 'zuqdah-labs';
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const MONTHLY_CEILING_USD = 10;                // Ziyad's standing limit for the whole lab programme
const IDLE_DAILY_USD = 0.10;                   // between runs the labs cost a fraction of a cent a day

// Runs the Azure CLI and parses its JSON. Returns { error } rather than throwing:
// a CLI that is missing or signed out means "could not check", never "fine".
function az(args) {
  const quote = (a) => {
    if (/"/.test(a)) throw new Error('refusing to pass an argument containing a double quote to the shell');
    return '"' + a + '"';
  };
  try {
    const out = execSync('az ' + args.map(quote).join(' ') + ' -o json', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26, timeout: 120000,
    });
    return { body: out.trim() ? JSON.parse(out) : null };
  } catch (e) {
    const text = String((e && (e.stderr || e.message)) || e).split('\n').map((l) => l.trim()).filter(Boolean);
    return { error: (text.find((l) => /ERROR|not recognized|not found|az login/i.test(l)) || text[0] || 'the Azure CLI failed').slice(0, 200) };
  }
}

// Pure judgements, so they can be shown both a passing and a failing case below.
function judgeSeats(assigned, included) {
  const paid = Math.max(0, Number(assigned) - Number(included));
  return { paid, ok: paid === 0, monthly: paid * 6 };
}
function judgeSpend(total30, lastThreeDays) {
  return {
    underCeiling: Number(total30) <= MONTHLY_CEILING_USD,
    idle: Number(lastThreeDays) <= IDLE_DAILY_USD * 3,
  };
}

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
// The numbers behind these four cases are the real ones: eight seats against five
// was the leak, and 1.74 USD is three days of it.
check(judgeSeats(8, 5).ok === false && judgeSeats(8, 5).paid === 3 && judgeSeats(8, 5).monthly === 18,
  'the seat check catches eight Basic licences against five free', JSON.stringify(judgeSeats(8, 5)));
check(judgeSeats(2, 5).ok === true && judgeSeats(5, 5).ok === true,
  'the seat check passes two of five, and exactly five of five');
check(judgeSpend(6.61, 1.74).idle === false && judgeSpend(18, 1.74).underCeiling === false,
  'the spend check catches a steady daily charge, and a month over the ceiling', JSON.stringify(judgeSpend(6.61, 1.74)));
check(judgeSpend(0.8, 0.0006).idle === true && judgeSpend(0.8, 0.0006).underCeiling === true,
  'the spend check passes an idle month');

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

// ============================================ 6. scheduled jobs nobody reads
// A lab's nightly cleanup failed for ten consecutive nights before anyone
// looked. A scheduled job that is red is a safety net nobody is holding, and
// GitHub does not tell you about it unless you go and see.
start('Workflows: nothing is quietly failing');
{
  const failing = [];
  const unread = [];
  let inspected = 0;
  for (const repo of repoDirs) {
    const name = path.basename(repo);
    const remote = git(repo, 'remote', 'get-url', 'origin') || '';
    const slug = (remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/) || [])[1];
    if (!slug) { unread.push(name + ' (no GitHub remote)'); continue; }
    const runs = await get('https://api.github.com/repos/' + slug + '/actions/runs?per_page=30', true);
    if (runs.error || !runs.body || !Array.isArray(runs.body.workflow_runs)) { unread.push(name + ' (' + (runs.error || 'unexpected response') + ')'); continue; }
    inspected++;
    // The latest COMPLETED run of each workflow is the one that says whether it works now.
    const latest = new Map();
    for (const run of runs.body.workflow_runs) {
      // A workflow whose file has since been deleted keeps its last run forever.
      // The clone was checked against its remote above, so the file is the test.
      if (!run.path || !fs.existsSync(path.join(repo, run.path.split('@')[0]))) continue;
      if (run.status === 'completed' && !latest.has(run.name)) latest.set(run.name, run);
    }
    for (const [workflow, run] of latest) {
      if (run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'startup_failure') {
        failing.push(name + ' / ' + workflow + ' (' + run.conclusion + ', ' + String(run.created_at).slice(0, 10) + ', ' + run.event + ')');
      }
    }
  }
  if (unread.length) unknown('read the workflow history of every repository', unread.join('; '));
  else pass('read the workflow history of every repository (' + inspected + ')');
  check(failing.length === 0, 'the most recent run of every workflow succeeded', failing.join('; '));
}

// ===================================================== 7. spend and licences
start('Spend and licences');
{
  // --- Azure DevOps seats: the organization's own accounting is what is billed.
  const summary = az(['rest', '--method', 'get', '--resource', ADO_RESOURCE,
    '--url', 'https://vsaex.dev.azure.com/' + ADO_ORG + '/_apis/userentitlementsummary?api-version=7.1-preview.1']);
  const basic = summary.body && Array.isArray(summary.body.licenses)
    ? summary.body.licenses.find((l) => l.licenseName === 'Basic')
    : null;
  if (summary.error || !basic) {
    unknown('read the Azure DevOps licence count', summary.error || 'no Basic licence in the summary');
  } else {
    const seats = judgeSeats(basic.assigned, basic.includedQuantity);
    check(seats.ok, 'no Azure DevOps seat is being paid for (' + basic.assigned + ' assigned, ' + basic.includedQuantity + ' free)',
      seats.paid + ' paid seat(s), about ' + seats.monthly + ' USD a month, billed by the day with no resource group to find it under');
  }

  const members = az(['rest', '--method', 'get', '--resource', ADO_RESOURCE,
    '--url', 'https://vsaex.dev.azure.com/' + ADO_ORG + '/_apis/memberentitlements?api-version=7.1-preview.2']);
  if (members.error || !members.body || !Array.isArray(members.body.items)) {
    unknown('listed who holds an Azure DevOps licence', members.error || 'unexpected response');
  } else if (members.body.items.length === 0) {
    // Whoever is running this is a licensed member, so an empty list is a failed read.
    unknown('listed who holds an Azure DevOps licence', 'the list came back empty, which cannot be true');
  } else {
    const leftovers = members.body.items
      .filter((m) => m.member && m.member.subjectKind === 'servicePrincipal' && /^guard-drill-/.test(m.member.displayName || ''))
      .map((m) => m.member.displayName);
    check(leftovers.length === 0, 'no drill identity is still holding a licence', leftovers.join(', '));
  }

  // --- Spend. The subscription is found by exact name and no other is queried.
  const subs = az(['account', 'list', '--query', "[?name=='" + LAB_SUBSCRIPTION + "'].id"]);
  const subId = subs.body && subs.body.length === 1 ? subs.body[0] : null;
  if (subs.error || !subId) {
    unknown('found the lab subscription', subs.error || 'expected exactly one subscription named "' + LAB_SUBSCRIPTION + '"');
  } else {
    const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
    const bodyFile = path.join(os.tmpdir(), 'drift-cost-query-' + process.pid + '.json');
    fs.writeFileSync(bodyFile, JSON.stringify({
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod: { from: day(30) + 'T00:00:00Z', to: day(0) + 'T23:59:59Z' },
      dataset: {
        granularity: 'Daily',
        aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
        grouping: [{ type: 'Dimension', name: 'ServiceName' }],
      },
    }));
    const cost = az(['rest', '--method', 'post',
      '--url', 'https://management.azure.com/subscriptions/' + subId + '/providers/Microsoft.CostManagement/query?api-version=2023-11-01',
      '--body', '@' + bodyFile.replace(/\\/g, '/')]);
    try { fs.unlinkSync(bodyFile); } catch { /* a leftover temp file is not worth failing on */ }

    const props = cost.body && cost.body.properties;
    if (cost.error || !props || !Array.isArray(props.rows)) {
      unknown('read the last thirty days of spend', cost.error || 'unexpected response');
    } else {
      const cols = props.columns.map((c) => c.name);
      const ci = cols.indexOf('Cost');
      const di = cols.indexOf('UsageDate');
      const si = cols.indexOf('ServiceName');
      const recent = [1, 2, 3].map((n) => day(n).replace(/-/g, ''));   // the three most recent COMPLETE days
      let total = 0;
      let lastThree = 0;
      const byService = {};
      for (const row of props.rows) {
        total += row[ci];
        byService[row[si]] = (byService[row[si]] || 0) + row[ci];
        if (recent.includes(String(row[di]))) lastThree += row[ci];
      }
      const top = Object.entries(byService).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => k + ' ' + v.toFixed(2)).join(', ');
      const verdict = judgeSpend(total, lastThree);
      check(verdict.underCeiling, 'the last thirty days cost ' + total.toFixed(2) + ' USD, within the ' + MONTHLY_CEILING_USD + ' USD ceiling',
        'largest: ' + top);
      check(verdict.idle, 'nothing is billing day after day (' + lastThree.toFixed(2) + ' USD over the last three complete days)',
        'an idle lab estate costs a fraction of a cent a day; largest over thirty days: ' + top);
    }
  }
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
