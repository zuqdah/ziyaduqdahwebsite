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

Above the document root is the point: nothing serves that folder over HTTP and
nothing in the git repository can reach it, so the key cannot be requested by a
visitor and cannot be committed by accident. `.gitignore` also blocks `*.key`
and `private/` so a mistake fails at `git add` rather than in public.

If you would rather use an environment variable, set `GROQ_API_KEY` in Plesk's
PHP settings instead — `chat.php` checks that first.

**3. Tell me when it is there** and I will test it, including trying to make it
invent things.

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

`MODEL` and `ENDPOINT` at the top of `chat.php`. The request body is
OpenAI-compatible, so Together, OpenRouter, Cloudflare Workers AI and most
open-weight hosts work by changing those two constants and the key.

Worth knowing: free tiers move. Groq removed Llama 3.3 70B from its free plan
in August 2026, and Cerebras replaced its free tier with a trial that needs a
card. If answers stop arriving, check the model name is still on the free plan
before assuming the code broke.
