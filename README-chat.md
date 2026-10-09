# Site assistant — setup

The assistant on the Scenarios section answers only from
[`capability-brief.md`](capability-brief.md). The browser posts to
[`chat.php`](chat.php), which holds the API key server-side and calls an
open-weight model.

Until the key is in place the widget shows a message pointing at the scenarios
and the email address. **The page is complete without it**, which is the
intended failure mode rather than an oversight.

## What you need to do

**1. Get a free API key.** Sign in at [console.groq.com](https://console.groq.com)
and create an API key. No card required.

**2. Put it on the server, outside the document root.** In Plesk's File
Manager, go one level *above* `httpdocs` and create a folder named `private`,
then a file inside it called `groq.key` containing the key and nothing else.

```
/var/www/vhosts/ziyaduqdah.com/
├── private/
│   └── groq.key        <- the key lives here
└── httpdocs/           <- the site, and what git deploys to
    ├── index.html
    ├── chat.php
    └── capability-brief.md
```

Above the document root is the point, and `chat.php` enforces it: a key found
inside `httpdocs` is **refused**, not used. During setup the key was placed in
`httpdocs/private/` and was not downloadable -- but only because the server
happened to answer 403 for that path, which is a config nobody chose for this
purpose and which a vhost template change would quietly remove. Reading it
anyway would mean the assistant worked perfectly while one server tweak stood
between the key and the public, and nothing would ever say so. `.gitignore` also blocks `*.key`
and `private/` so a mistake fails at `git add` rather than in public.

If you would rather use an environment variable, set `GROQ_API_KEY` in Plesk's
PHP settings instead — `chat.php` checks that first.

**3. Tell me when it is there** and I will test it, including trying to make it
invent things.

## Editing the grounding file

`capability-brief.md` is the **only** source the assistant may answer from. It
is read by `chat.php` at request time and sent as the system context.

Every fact in it is transcribed from `index.html` and from the public lab
repositories, both of which derive from Ziyad's resume. **Do not add to it from
memory.** If a fact is not in there, the assistant is required to say it does
not know — a career assistant that invents an employer, a date or a
certification is worse than no assistant.

**Write it addressed to the model, and put developer notes here instead.** It
used to open with fifteen lines of notes about this file, `chat.php` and the
token budget. The model received every word of that as its system context, and
it showed: asked which lab to read first, the assistant replied "the brief does
not specify a recommended order for the labs" — plumbing a visitor should never
see, in vocabulary the file itself had handed it. Those notes also cost around
150 tokens on every single request.

Keep it under roughly 1,800 tokens. The free tier allows 200,000 tokens a day
and the whole file is resent on every call, so its length is the main thing
deciding how many conversations the site can serve.

## What it costs

Nothing, within the free tier: **1,000 requests and 200,000 tokens a day**.

The token ceiling binds long before the request count, because the grounding
brief is resent on every single call. At roughly 1,800 tokens of brief plus a
capped 400-token reply, that is somewhere around 80–90 conversations a day.
`capability-brief.md` is therefore kept deliberately short — adding a thousand
words to it halves how many people the site can answer.

## The guards, and why each exists

| Guard | Value | Why |
|---|---|---|
| Per-IP limit | 12 messages / 15 min | One visitor cannot drain the daily budget |
| Site-wide daily cap | 300 requests | Degrades on our terms, well before the provider cuts us off at 1,000 |
| Max output tokens | 400 | Protects the token budget and keeps answers readable |
| Max question length | 600 characters | A question, not a pasted document |
| History cap | 4 turns, 1,200 chars each | Context cannot grow without bound across a conversation |

Counters use `flock`. Read-then-write would let two simultaneous visitors both
read the same count and both write count+1, so the limit would stop being a
limit exactly when traffic arrived. If a counter cannot be opened at all the
request is **refused** — an unenforceable limit must not read as an absent one.

## The part that matters more than cost

This thing answers questions about somebody's career to people considering
hiring him. **A confident invented fact is worse than no assistant**, so:

- It answers only from `capability-brief.md`, which is transcribed from
  `index.html` and the public lab repositories.
- It is told to say it does not know and point at the email address rather than
  fill a gap.
- It is told not to state years of experience with a named technology unless
  the brief says so, not to claim certifications, and not to speculate about
  availability or rate.
- It refers to Ziyad in the third person. It is an assistant on his site, not
  him — answering as though it were him would misrepresent both.
- If `capability-brief.md` is missing or empty, `chat.php` **refuses to answer**
  rather than letting the model reply from its own training, which is the exact
  failure this design exists to prevent.

That last one is the load-bearing check. Everything else is a cost control.

## Changing the model or provider

Three providers are wired into `chat.php`, in the `PROVIDERS` table at the
top: `groq` (gpt-oss-120b, the default), `gemini` (gemini-3.8-flash through
Google's OpenAI-compatible endpoint) and `anthropic` (Claude Haiku 5.5 through
the Messages API). Which one answers is decided outside the repository, next
to the keys: set `ASSISTANT_PROVIDER` in the environment, or put the one word
in `private/assistant.provider`. Each provider reads its own key
(`private/groq.key`, `private/gemini.key`, `private/anthropic.key`, or the
matching `*_API_KEY` variable), so every key can be in place and the file
decides. A name that is not in the table is refused with a 503 rather than
falling back: a typo must not quietly route visitors' questions to a
different company.

Adding a provider is a row in that table. Groq and Gemini speak the OpenAI
chat-completions shape, so Together, OpenRouter, Cloudflare Workers AI and
most open-weight hosts need only a model, an endpoint and a key name. The
Anthropic row speaks the Messages shape -- the brief goes in a separate
`system` field, the reply comes back as content blocks -- and a row may also
set its own output ceiling and token ceilings, because the shared ones were
sized for Groq's tokenizer and Groq's free tier.

**Haiku 5.5 is the one paid option, and it is the one that passed cleanly.**
Tried on 2026-10-09, locally, the same way as Gemini below: 17/17 on the
second pass, 14/17 on the first, with no provider errors in either. The three
that did not pass first time were two replies cut at the 400-token output
ceiling -- Haiku answers at greater length than gpt-oss for the same question,
so its row sets 600 -- and one call refused by `chat.php`'s own per-visitor
limit, because the smoke test before the run had counted. It is also the
fastest of the three, under two seconds a call. What it costs: Claude counts
the brief at about 4,900 tokens, a question runs 5,000-5,500 tokens in all,
and at $0.10 per million in and $0.50 per million out that is about a
twentieth of a cent each. The two eval runs together cost just over one cent.
The row's token ceilings (600,000 a day, 12,000 a minute) are a cost cap of
about six cents a day. It runs on prepaid credit, not a free tier, so the
assistant stops when the balance does; a spend limit in the Console is the
backstop.

To switch the live site: put `anthropic.key` beside `groq.key` above
`httpdocs`, write the word `anthropic` into `private/assistant.provider`,
and run `dev/eval.mjs --run` against the live URL. Change the file back to
switch back; nothing in the repository moves.

**Gemini was tried on 2026-10-09 and is not the default, for a reason worth
keeping.** Over two eval runs from a fresh project, the free tier answered 10
of 27 calls; the rest were `503 "This model is currently experiencing high
demand"` (eleven), `429` (four), and a `403 "API has not been used in this
project"` that kept returning for twenty minutes after the API was enabled.
Every answer it did give passed its case, and it used no markdown, so the
model is fine; the free tier is not something a visitor can be handed. Two
more differences if it is ever promoted: Google counts the same brief at
about 3,400 prompt tokens where Groq counts 2,300, so the token ceilings in
`chat.php` must be re-based from the limits AI Studio shows for the project
(Google does not publish them); and the free tier's terms allow the content to
be used to improve Google's products, which Groq's do not. The local run that
found all this is reproducible: serve `chat.php` with
`php -S` from a container, mount a `private/` directory one level above it,
set `ASSISTANT_PROVIDER`, and point `dev/eval.mjs --url` at it, at the
production pace -- faster trips `chat.php`'s own per-visitor limit, since
every eval call comes from one address.

Worth knowing: free tiers move. Groq removed Llama 3.3 70B from its free plan
in August 2026, and Cerebras replaced its free tier with a trial that needs a
card. If answers stop arriving, check the model name is still on the free plan
before assuming the code broke.
