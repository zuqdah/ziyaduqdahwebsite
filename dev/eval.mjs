#!/usr/bin/env node
/**
 * Grades the site assistant against dev/assistant-eval.json.
 *
 * Why this exists: "the answers got better" is not a measurement, and every
 * knob worth turning on the endpoint -- the model, temperature, reasoning
 * effort, how much of the brief is sent -- changes behaviour in ways nobody can
 * hold in their head across seventeen questions. So the expectations are
 * declared in a file before the run, the grading is deterministic patterns, and
 * a case whose result could not be read is Unknown rather than a pass.
 *
 * No model grades another model here. An LLM judge can be wrong in the same
 * direction as the thing it is judging, which is the one failure a check must
 * not have.
 *
 *   node dev/eval.mjs --self-test          prove the graders can fail. No network.
 *   node dev/eval.mjs --plan               show what a run would cost. No network.
 *   node dev/eval.mjs --run                run it
 *   node dev/eval.mjs --run --cases a,b    just those
 *   node dev/eval.mjs --run --pace 40      seconds between calls
 *
 * Pacing is not politeness. The endpoint's own ceilings are 7,000 tokens a
 * minute and 12 questions per visitor per 15 minutes, and this runner is a
 * single visitor asking seventeen questions. Unpaced, it rate-limits itself and
 * every Unknown after that says nothing about the model.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(here, 'assistant-eval.json');
const REPORT = resolve(here, 'eval-report.json');

const DEFAULT_URL = 'https://ziyaduqdah.com/chat.php';
const DEFAULT_PACE = 75;          // seconds; see the note above
const EST_TOKENS_PER_CALL = 2900; // brief + one question + one reply, no history

/* ------------------------------------------------------------------ arguments */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const spec = JSON.parse(readFileSync(SPEC, 'utf8'));

/* ------------------------------------------------------------------- graders */

const rx = (pattern) => new RegExp(pattern, 'i');

// Every repository name the brief is allowed to route to. Used by the
// minLabsMentioned check, and kept in one place so a new lab is added once.
const LAB_NAMES = [
  'before-the-first-sync', 'disaster-recovery-actually-failed-over',
  'entra-cutover-without-lockout', 'least-privilege-proven',
  'integration-that-survives-failure', 'sql-migration-with-rollback',
  'windows-baseline-automation', 'azure-agent-landing-zone',
  'agentic-ops-copilot', 'self-healing-aiops', 'copilot-studio-alm',
  'pipelines-that-refuse', 'the-second-run-changed-nothing',
  'the-import-said-success',
];

const EMAIL = 'ziyad@ziyaduqdah.com';

/**
 * Grades one reply. Returns the failures, which is the empty list for a pass.
 *
 * Note what is NOT here: any judgement about whether the answer was good. This
 * grades the rules the brief states, because those are the ones that can be
 * checked the same way twice.
 */
function grade(testCase, reply, finishReason) {
  const failures = [];

  for (const rule of spec.globals.forbidden) {
    if (rx(rule.pattern).test(reply)) {
      failures.push(`global ${rule.id}: ${rule.why}`);
    }
  }

  const words = reply.split(/\s+/).filter(Boolean).length;
  if (words > spec.globals.maxWords) {
    failures.push(`${words} words, over the ${spec.globals.maxWords} the brief's "two or three short paragraphs" allows`);
  }

  // Truncation is not a grading question, it is a configuration one -- but it
  // has to fail, because a reply cut off mid-sentence would otherwise be graded
  // on the half that arrived.
  if (finishReason === 'length') {
    failures.push('reply was truncated at the output ceiling (finish_reason=length)');
  }

  for (const pattern of testCase.mustIncludeAll ?? []) {
    if (!rx(pattern).test(reply)) failures.push(`missing required: /${pattern}/`);
  }

  const any = testCase.mustIncludeAny ?? [];
  if (any.length && !any.some((p) => rx(p).test(reply))) {
    failures.push(`none of the acceptable answers present: ${any.map((p) => `/${p}/`).join(', ')}`);
  }

  for (const pattern of testCase.mustNotInclude ?? []) {
    if (rx(pattern).test(reply)) failures.push(`present but forbidden: /${pattern}/`);
  }

  if (testCase.expectEmail && !reply.includes(EMAIL)) {
    failures.push(`did not point at ${EMAIL}, which the brief requires when the answer is not in it`);
  }

  if (testCase.minLabsMentioned) {
    const found = LAB_NAMES.filter((n) => reply.toLowerCase().includes(n));
    if (found.length < testCase.minLabsMentioned) {
      failures.push(`named ${found.length} lab(s), expected at least ${testCase.minLabsMentioned}`);
    }
  }

  if (testCase.mustAskQuestion && !reply.includes('?')) {
    failures.push('did not ask the reader which route fits');
  }

  return failures;
}

/* ----------------------------------------------------------------- self-test */

/**
 * A grader that cannot fail is worse than no grader: it reports a clean run
 * over broken output. So each check is shown a reply that violates it and must
 * catch it, and a reply that satisfies it and must not.
 *
 * This is the only part of the file that can be trusted without spending a
 * token, and it is the part that decides whether the rest means anything.
 */
function selfTest() {
  const ok = { id: 'x', question: 'q' };
  const cases = [
    ['markdown bold is caught', ok, 'He worked at **US Cloud** doing support.', 'stop', true],
    ['markdown heading is caught', ok, '# Experience\nHe worked at US Cloud.', 'stop', true],
    ['backticks are caught', ok, 'See the `least-privilege-proven` lab.', 'stop', true],
    ['an invented certification is caught', ok, 'He holds AZ-305 among others.', 'stop', true],
    ['naming its own instructions is caught', ok, 'My instructions say I may only use what is here.', 'stop', true],
    ['a coined acronym is caught', ok, 'His data-loss objective was four hours.', 'stop', true],
    ['an overlong reply is caught', ok, 'word '.repeat(spec.globals.maxWords + 10), 'stop', true],
    ['truncation is caught', ok, 'He works at US Cloud and', 'length', true],
    ['a clean reply passes', ok, 'He works at US Cloud as a Senior Microsoft Systems Engineer.', 'stop', false],

    ['a missing required string is caught',
      { ...ok, mustIncludeAll: ['US Cloud'] }, 'He works somewhere in Louisiana.', 'stop', true],
    ['a present required string passes',
      { ...ok, mustIncludeAll: ['US Cloud'] }, 'He works at US Cloud.', 'stop', false],

    ['none-of-the-alternatives is caught',
      { ...ok, mustIncludeAny: ['pipelines-that-refuse'] }, 'There is a lab about pipelines.', 'stop', true],
    ['one-of-the-alternatives passes',
      { ...ok, mustIncludeAny: ['pipelines-that-refuse', 'copilot-studio-alm'] },
      'Look at copilot-studio-alm first.', 'stop', false],

    ['a forbidden string is caught',
      { ...ok, mustNotInclude: ['\\$\\s?\\d'] }, 'He is looking for $150,000.', 'stop', true],

    ['a missing deflection is caught',
      { ...ok, expectEmail: true }, 'No certifications are listed here.', 'stop', true],
    ['a deflection with the address passes',
      { ...ok, expectEmail: true },
      `No certifications are listed here. For anything beyond that, email ${EMAIL}.`, 'stop', false],

    ['too few labs named is caught',
      { ...ok, minLabsMentioned: 2 }, 'Start with least-privilege-proven.', 'stop', true],
    ['enough labs named passes',
      { ...ok, minLabsMentioned: 2 },
      'Start with least-privilege-proven, or sql-migration-with-rollback if migration is the worry.', 'stop', false],

    ['not asking the reader is caught',
      { ...ok, mustAskQuestion: true }, 'Start with least-privilege-proven.', 'stop', true],

    // The Terraform patterns are the subtlest thing in the spec: they must catch
    // a fabricated duration for Terraform without catching the career total,
    // which is a fact the brief states.
    ['a fabricated Terraform duration is caught',
      spec.cases.find((c) => c.id === 'deflect-years-terraform'),
      `He has about five years of Terraform experience. Email ${EMAIL}.`, 'stop', true],
    ['the stated career total is not mistaken for one',
      spec.cases.find((c) => c.id === 'deflect-years-terraform'),
      `He has nineteen-plus years across systems administration and cloud architecture, though how much of that involved Terraform is not stated here. Email ${EMAIL}.`,
      'stop', false],
  ];

  let pass = 0;
  const broken = [];

  for (const [name, testCase, reply, finish, shouldFail] of cases) {
    const failures = grade(testCase, reply, finish);
    const didFail = failures.length > 0;
    if (didFail === shouldFail) {
      pass++;
      console.log(`  PASS  ${name}`);
    } else {
      broken.push(name);
      console.log(`  BROKEN ${name}`);
      console.log(`         expected ${shouldFail ? 'a failure' : 'a pass'}, got ${didFail ? failures.join('; ') : 'a pass'}`);
    }
  }

  console.log(`\n  ${pass}/${cases.length} grader checks behave as declared`);
  if (broken.length) {
    console.log('\n  The graders are not trustworthy. A run now would report a clean sheet it has not earned.');
    process.exit(1);
  }
  return true;
}

/* ---------------------------------------------------------------------- plan */

function plan(chosen) {
  const pace = Number(value('pace', DEFAULT_PACE));
  const tokens = chosen.length * EST_TOKENS_PER_CALL;
  console.log(`  ${chosen.length} cases against ${value('url', DEFAULT_URL)}`);
  console.log(`  roughly ${tokens.toLocaleString()} tokens, which is ${Math.round((tokens / 190000) * 100)}% of the endpoint's daily ceiling`);
  console.log(`  ${pace}s between calls, so about ${Math.ceil((chosen.length * pace) / 60)} minutes`);
  console.log('  no money either way: the provider tier is free, the cost is the assistant being');
  console.log('  quieter for visitors for the rest of the day. Worth running off-peak.');
}

/* ----------------------------------------------------------------------- run */

async function ask(url, question) {
  // No history. Each case is independent, and sending history would both cost
  // more and make a failure depend on the case before it.
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: question, history: [] }),
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, why: `HTTP ${response.status}, and the body was not JSON: ${text.slice(0, 200)}` };
  }

  if (!response.ok) {
    // A 429 is our own endpoint refusing before it calls the provider, so it
    // cost nothing. Anything else may well have reached the provider.
    return {
      ok: false,
      why: `HTTP ${response.status}: ${body.error ?? text.slice(0, 200)}`,
      providerCalled: response.status !== 429,
      usage: body.usage,
    };
  }

  const reply = typeof body.reply === 'string' ? body.reply.trim() : '';
  if (!reply) return { ok: false, why: 'the endpoint returned no reply' };

  // An endpoint that does not report finish_reason is one that predates the
  // measurement change, and truncation would be invisible. That is not a pass.
  if (typeof body.finish_reason !== 'string') {
    // The reply arrived, so the provider was called and the tokens are gone --
    // they just cannot be counted. providerCalled says so, because the first
    // draft of this file reported "0 tokens spent" for exactly this case, which
    // is the same mistake the endpoint made and this whole exercise is about.
    return {
      ok: false,
      why: 'no finish_reason in the response -- the deployed chat.php predates the measurement change, so truncation cannot be seen',
      providerCalled: true,
      usage: body.usage,
    };
  }

  return { ok: true, reply, finishReason: body.finish_reason, usage: body.usage ?? {}, providerCalled: true };
}

const sleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

async function run(chosen) {
  const url = value('url', DEFAULT_URL);
  const pace = Number(value('pace', DEFAULT_PACE));
  const results = [];
  let tokens = 0;
  let unmeasured = 0;   // calls that reached the provider and did not report a cost

  for (const [index, testCase] of chosen.entries()) {
    process.stdout.write(`  [${index + 1}/${chosen.length}] ${testCase.id.padEnd(30)} `);

    let outcome;
    try {
      const answer = await ask(url, testCase.question);
      const spent = answer.usage?.total_tokens ?? 0;
      if (answer.providerCalled) {
        if (spent > 0) tokens += spent;
        else unmeasured++;
      }
      if (!answer.ok) {
        outcome = { outcome: 'Unknown', reason: answer.why };
      } else {
        const failures = grade(testCase, answer.reply, answer.finishReason);
        outcome = {
          outcome: failures.length ? 'Fail' : 'Pass',
          failures,
          reply: answer.reply,
          finishReason: answer.finishReason,
          usage: answer.usage,
        };
      }
    } catch (error) {
      outcome = { outcome: 'Unknown', reason: `request threw: ${error.message}` };
    }

    results.push({ id: testCase.id, severity: testCase.severity ?? 'Behaviour', question: testCase.question, ...outcome });
    console.log(outcome.outcome === 'Pass' ? 'Pass' : `${outcome.outcome}`);
    for (const f of outcome.failures ?? []) console.log(`        ${f}`);
    if (outcome.reason) console.log(`        ${outcome.reason}`);

    if (index < chosen.length - 1) await sleep(pace);
  }

  return { results, tokens, unmeasured };
}

/* --------------------------------------------------------------------- report */

function report({ results, tokens, unmeasured }) {
  const count = (name) => results.filter((r) => r.outcome === name).length;
  const passed = count('Pass');
  const failed = count('Fail');
  const unknown = count('Unknown');

  console.log('\n' + '-'.repeat(72));
  console.log(`  ${passed}/${results.length} as declared; ${failed} failed; ${unknown} inconclusive.`);
  // Never a bare total when part of it could not be read. An unmeasured cost
  // reported as zero is how a budget stops being one.
  if (unmeasured) {
    console.log(`  ${tokens.toLocaleString()} tokens measured, plus ${unmeasured} call(s) that reached the provider`);
    console.log(`  without reporting a cost -- roughly ${(unmeasured * EST_TOKENS_PER_CALL).toLocaleString()} more, unverified.`);
  } else {
    console.log(`  ${tokens.toLocaleString()} tokens spent.`);
  }

  const baselines = results.filter((r) => r.severity === 'Baseline');
  if (baselines.some((r) => r.outcome !== 'Pass')) {
    console.log('\n  A BASELINE case did not pass. The endpoint or the grader is broken, and');
    console.log('  nothing else on this run can be read as being about the model.');
  }

  const truncated = results.filter((r) => r.finishReason === 'length').length;
  if (truncated) {
    console.log(`\n  ${truncated} reply/replies hit the output ceiling. Raise MAX_OUTPUT_TOKENS in chat.php,`);
    console.log('  remembering that reasoning tokens come out of the same allowance.');
  }

  const reasoning = results.map((r) => r.usage?.reasoning_tokens ?? 0).filter((n) => n > 0);
  if (reasoning.length) {
    const total = reasoning.reduce((a, b) => a + b, 0);
    console.log(`\n  Reasoning tokens: ${total.toLocaleString()} over ${reasoning.length} replies, ~${Math.round(total / reasoning.length)} each.`);
  }

  writeFileSync(REPORT, JSON.stringify({ generatedUtc: new Date().toISOString(), url: value('url', DEFAULT_URL), passed, failed, unknown, tokens, unmeasuredCalls: unmeasured, results }, null, 2));
  console.log(`\n  Replies written to ${REPORT}`);

  // Inconclusive is not a pass. A run that could not read its own result must
  // not exit green, or the next change gets made against a number nobody earned.
  return failed === 0 && unknown === 0;
}

/* ----------------------------------------------------------------------- main */

const only = value('cases', '').split(',').map((s) => s.trim()).filter(Boolean);
const chosen = only.length ? spec.cases.filter((c) => only.includes(c.id)) : spec.cases;

if (only.length && chosen.length !== only.length) {
  const missing = only.filter((id) => !spec.cases.some((c) => c.id === id));
  console.error(`No such case: ${missing.join(', ')}`);
  process.exit(2);
}

if (flag('self-test')) {
  console.log('Grader self-test -- no network, no tokens.\n');
  selfTest();
  process.exit(0);
}

if (flag('plan') || !flag('run')) {
  console.log('Plan only. Add --run to execute.\n');
  plan(chosen);
  if (!flag('plan')) console.log('\n  (--self-test proves the graders work without spending anything.)');
  process.exit(0);
}

// The graders always run first. There is no mode in which this spends tokens
// before proving it can tell a good reply from a bad one.
console.log('Grader self-test first.\n');
selfTest();
console.log(`\nRunning ${chosen.length} cases against ${value('url', DEFAULT_URL)}.\n`);
const outcome = await run(chosen);
process.exit(report(outcome) ? 0 : 1);
