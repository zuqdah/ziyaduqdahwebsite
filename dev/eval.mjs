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
// Measured, not guessed: the first live call reported prompt=2308, completion=60,
// reasoning=22, total=2368. Rounded up for the routing cases, whose answers are
// longer than "he works at US Cloud".
const EST_TOKENS_PER_CALL = 2600;

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

/**
 * Normalises the whitespace a language model actually emits.
 *
 * The first real run graded a correct answer as a failure. The reply said
 * "Senior Microsoft Systems Engineer in Premier Support at US Cloud" and the
 * check for "US Cloud" did not match, because the space between US and Cloud was
 * U+202F, a narrow no-break space. Models reach for these constantly -- narrow
 * and non-breaking spaces, thin spaces, zero-width joiners -- and every one of
 * them turns an exact string check into a coin toss.
 *
 * The fix belongs here and not in the patterns. Loosening every pattern to
 * tolerate exotic whitespace would mean writing s+ everywhere and hoping, and
 * a pattern nobody can read stops being a specification. Normalise the input,
 * keep the patterns literal.
 *
 * This is also why the baseline cases exist: without a case asking something the
 * brief states plainly, this would have read as the model failing to name the
 * employer rather than the grader failing to see it.
 */
function normalise(text) {
  return text
    .replace(/[​‌‍⁠﻿]/g, '')          // zero width: remove
    .replace(/[   -   　]/g, ' '); // space-like: make it a space
}

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
function grade(testCase, rawReply, finishReason) {
  const failures = [];
  const reply = normalise(rawReply);

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

  // Built from code points rather than written as escapes in a string literal.
  // The first attempt at these cases wrote   into the source and it arrived
  // as a plain space, so all three passed without the normaliser doing anything
  // -- three green lines proving nothing, in the fix for a grader that had
  // already graded a correct answer wrong. The assertion below makes that
  // failure mode impossible to repeat quietly.
  const NNBSP = String.fromCodePoint(0x202f);  // narrow no-break space
  const NBSP = String.fromCodePoint(0x00a0);   // no-break space
  const ZWSP = String.fromCodePoint(0x200b);   // zero-width space

  // Any case named here asserts its own premise: the raw reply must NOT match
  // the literal pattern, or the case is vacuous and the run stops.
  const needsNormalising = new Set([
    'a narrow no-break space does not hide a match',
    'a non-breaking space does not hide a match',
    'a zero-width space does not hide a match',
  ]);

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

    // Regression: the exact reply the first live run returned, including the
    // narrow no-break space the model really put between US and Cloud.
    ['a narrow no-break space does not hide a match',
      { ...ok, mustIncludeAll: ['US Cloud'] },
      `Ziyad is currently a Senior Microsoft Systems Engineer in Premier Support at US${NNBSP}Cloud, a role he has held since December 2023.`,
      'stop', false],
    ['a non-breaking space does not hide a match',
      { ...ok, mustIncludeAll: ['US Cloud'] }, `He works at US${NBSP}Cloud.`, 'stop', false],
    ['a zero-width space does not hide a match',
      { ...ok, mustIncludeAll: ['US Cloud'] }, `He works at US${ZWSP} Cloud.`, 'stop', false],

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
    // A whitespace case whose reply would match anyway is testing nothing. This
    // is what caught the first attempt, where the escape collapsed to a plain
    // space and three cases went green without the normaliser being involved.
    if (needsNormalising.has(name)) {
      const pattern = testCase.mustIncludeAll[0];
      if (new RegExp(pattern, 'i').test(reply)) {
        console.log(`  VACUOUS ${name}`);
        console.log(`         the reply matches /${pattern}/ without normalising, so this case proves nothing.`);
        console.log('         The exotic whitespace it is supposed to contain is not there.');
        broken.push(name);
        continue;
      }
    }

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
