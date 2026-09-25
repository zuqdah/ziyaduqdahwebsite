# dev/

Nothing in here is part of the site. It is served to nobody: the nginx config
denies `/dev/` outright, which is why this directory exists at all.

The web root and the repository root are the same directory on this server --
Plesk deploys the repository straight into `httpdocs` -- so every file added to
the repository becomes a URL. That is not obvious, and it has already bitten
once: `CACHING.md` was written as internal notes and immediately became a public
page listing the API key's server path and the exact rate-limit values.

The page itself needs exactly three local files:

| File | Why |
|---|---|
| `index.html` | the page |
| `chat.php` | the assistant proxy |
| `Ziyad_Uqdah_Resume.pdf` | linked from the page |

Everything else -- tests, notes, the grounding brief -- is support material.
`chat.php` reads `capability-brief.md` off the filesystem, not over HTTP, so even
that does not need to be served. **New support files belong in here**, where one
`deny` rule already covers them, rather than in the root where each one needs
remembering.

## Running the tests

```bash
node dev/test-plain.mjs
```

It extracts `plain()` out of `index.html` by regex rather than keeping its own
copy, so the test cannot pass against a version of the function the site does
not ship. If the function is renamed or reformatted the extraction fails loudly
with exit code 2 instead of silently testing nothing.

```bash
docker run --rm -v "$PWD:/app" -w /app php:8.3-cli-alpine php dev/test-budget.php
```

The windowed counters out of `chat.php`, extracted the same way and for the same
reason. They decide whether the assistant answers at all, and they now do
arithmetic rather than counting to one, so they are worth testing. The last two
assertions are about the constants rather than the code: that the reserve really
does cover a worst-case call, and that the old request limit could not have
protected the token budget.

## The assistant eval

```bash
node dev/eval.mjs --self-test    # prove the graders can fail. No network, no tokens.
node dev/eval.mjs --plan         # what a run would cost
node dev/eval.mjs --run
```

Seventeen questions with expectations declared in `assistant-eval.json` before
the run, graded by deterministic patterns. **No model grades another model**: a
judge can be wrong in the same direction as the thing it judges, which is the one
failure a check must not have.

Three things about it are deliberate:

**The graders are self-tested first, always.** There is no mode that spends a
token before proving the checks can tell a good reply from a bad one. A grader
that cannot fail reports a clean run over broken output, which is worse than no
grader.

**Two cases are positive controls.** `baseline-current-employer` and
`baseline-remote` ask things the brief states plainly. If either fails, the
endpoint or the grader is broken and nothing else on that run can be read as
being about the model. The report says so rather than leaving it to be noticed.

**Inconclusive is not a pass.** A case whose result could not be read is
`Unknown` and the run exits non-zero. An endpoint that returns no
`finish_reason` is one that predates the measurement change in `chat.php`, so
truncation would be invisible -- that is Unknown too, not a clean sheet.

Pacing matters. The endpoint allows 7,000 tokens a minute and 12 questions per
visitor per 15 minutes, and the runner is one visitor asking seventeen questions,
so the default is 75 seconds between calls and a full run takes about 22 minutes.
Unpaced it rate-limits itself, and every Unknown after that says nothing about
the model. A run costs roughly a quarter of the endpoint's daily token ceiling,
so it is worth running off-peak: no money either way on a free tier, but the
assistant is quieter for real visitors for the rest of that day.
