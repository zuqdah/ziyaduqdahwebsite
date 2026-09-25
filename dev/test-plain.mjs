import fs from 'fs';
// Pull the real function out of index.html so the test cannot drift from ship.
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const m = html.match(/function plain\(text\) \{[\s\S]*?\n  \}/);
if (!m) { console.error('could not extract plain() from index.html'); process.exit(2); }
const plain = new Function('return (' + m[0].replace(/^function plain/, 'function') + ')')();
console.log('extracted plain() from index.html, ' + m[0].split('\n').length + ' lines\n');

const cases = [
  ['The lab that measured recovery time is ** disaster-recovery-actually-failed-over **. In this lab',
   'The lab that measured recovery time is disaster-recovery-actually-failed-over. In this lab'],
  ['The **disaster-recovery-actually-failed-over** lab measured recovery time.',
   'The disaster-recovery-actually-failed-over lab measured recovery time.'],
  // Non-breaking hyphens are now converted, and this case used to assert the
  // opposite. The earlier expectation was that exotic punctuation should be left
  // alone as the model's typography; the evidence that overturned it is a full
  // eval run, where 26 of these appeared and the repository names carrying them
  // were unpasteable. A name a reader cannot paste into a search is not
  // typography, it is a dead end that reads as the lab not existing.
  ['calculated the recovery‑time‑objective (RTO) starting',
   'calculated the recovery-time-objective (RTO) starting'],
  // The reply that exposed it, verbatim from dev/eval-report.json.
  ['He measures it in the the‑second‑run‑changed‑nothing lab.',
   'He measures it in the the-second-run-changed-nothing lab.'],
  // Every joining dash in one name, so a single-pass bug that fixed only the
  // first or only alternate hyphens would fail here.
  ['See entra‑cutover‑without‑lockout for that.',
   'See entra-cutover-without-lockout for that.'],
  // A spaced en dash is punctuation, not a joiner, and must survive.
  ['copilot-studio-alm – treats an agent as source.',
   'copilot-studio-alm – treats an agent as source.'],
  // A narrow no-break space, which is what made a correct answer fail the eval.
  ['He works at US Cloud today.', 'He works at US Cloud today.'],
  // Zero-width characters are removed outright rather than turned into spaces.
  ['the​import​said​success', 'theimportsaidsuccess'],
  // A minus sign between digits is a joining dash by the rule above. Converting
  // it is correct here: this is prose about a range, not arithmetic.
  ['2019–2021 at Accruent', '2019-2021 at Accruent'],
  ['__bold__ and `code` here', 'bold and code here'],
  ['# Heading\nbody', 'Heading\nbody'],
  ['### Deep\nbody', 'Deep\nbody'],
  ['```\nfenced\n```', 'fenced'],
  ['```bash\ncurl x\n```', 'curl x'],
  ['2 * 3 * 4 = 24', '2 * 3 * 4 = 24'],
  ['a_b_c variable names', 'a_b_c variable names'],
  ['- one\n- two', '- one\n- two'],
  ['He works at C Spire and MegaGate.', 'He works at C Spire and MegaGate.'],
  ['ziyad@ziyaduqdah.com', 'ziyad@ziyaduqdah.com'],
  ['Rate is 5*x', 'Rate is 5*x'],
  ['**multi\nline bold**', 'multi\nline bold'],
  ['Ziyad\u2019s profile does not list any Azure certifications.\n\nHis expected salary is not provided on this site.',
   'Ziyad\u2019s profile does not list any Azure certifications.\n\nHis expected salary is not provided on this site.'],
  ['  leading and trailing  ', 'leading and trailing'],
  // A leading switch dash, which the first version of this fix missed because it
  // required an alphanumeric BEFORE the dash. Found by asking the live site a
  // routing question and reading what it rendered; the eval had not caught it
  // because its own rule only looked at repository names.
  ['tested modules that include a ‑WhatIf mode',
   'tested modules that include a -WhatIf mode'],
  ['run it with (‑Force) to skip', 'run it with (-Force) to skip'],
  // Verbatim from the live page, the reply that exposed it.
  ['He also automates baseline configuration with PowerShell in the “windows‑baseline‑automation” lab, turning legacy scripts into tested modules that include a ‑WhatIf mode.',
   'He also automates baseline configuration with PowerShell in the “windows-baseline-automation” lab, turning legacy scripts into tested modules that include a -WhatIf mode.'],
  // An em dash between two phrases is punctuation and must survive untouched,
  // which is the whole reason the decision is made per occurrence.
  ['the labs — and nothing else — are the point',
   'the labs — and nothing else — are the point'],
  ['copilot-studio-alm – treats an agent as source.',
   'copilot-studio-alm – treats an agent as source.'],
  // A dash the model used to open a list item is not a joiner.
  ['‑ one\n‑ two', '‑ one\n‑ two'],
  // Contexts the enumerated version missed: an opening smart quote and a colon.
  ["the “‑WhatIf” switch", "the “-WhatIf” switch"],
  ["see docs:‑WhatIf for that", "see docs:-WhatIf for that"],
  // Still punctuation: whitespace on both sides.
  ["labs ‑ and nothing else", "labs ‑ and nothing else"],
];
// The test data has to contain the characters it is about, and half of them are
// invisible in this file. An editor or a tidy-up that replaced a non-breaking
// hyphen with a plain one would leave every case passing and testing nothing --
// which has already happened once, in dev/eval.mjs, where three green lines
// proved nothing for exactly this reason.
//
// So the premise is asserted before anything runs. Counts rather than presence,
// because losing some of them is the more likely accident.
const premise = [
  ['non-breaking hyphen U+2011', 0x2011, 12],
  ['narrow no-break space U+202F', 0x202f, 1],
  ['zero-width space U+200B', 0x200b, 3],
  ['en dash U+2013', 0x2013, 3],
  ['em dash U+2014', 0x2014, 2],
];
const allInputs = cases.map(([input]) => input).join('');
let premiseBroken = false;
for (const [name, codePoint, atLeast] of premise) {
  const seen = [...allInputs].filter((ch) => ch.codePointAt(0) === codePoint).length;
  if (seen < atLeast) {
    console.error(`PREMISE BROKEN: expected at least ${atLeast} of ${name} in the test data, found ${seen}.`);
    console.error('The cases below cannot be testing what they claim to test.');
    premiseBroken = true;
  }
}
if (premiseBroken) process.exit(2);

let bad = 0;
for (const [input, want] of cases) {
  const got = plain(input);
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + JSON.stringify(input));
  if (!ok) { console.log('        want ' + JSON.stringify(want)); console.log('        got  ' + JSON.stringify(got)); }
}
console.log('\n' + (cases.length - bad) + '/' + cases.length + ' passed');
process.exit(bad ? 1 : 0);
