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
  ['calculated the recovery\u2011time\u2011objective (RTO) starting',
   'calculated the recovery\u2011time\u2011objective (RTO) starting'],
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
];

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
