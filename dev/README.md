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

## Running the test

```bash
node dev/test-plain.mjs
```

It extracts `plain()` out of `index.html` by regex rather than keeping its own
copy, so the test cannot pass against a version of the function the site does
not ship. If the function is renamed or reformatted the extraction fails loudly
with exit code 2 instead of silently testing nothing.
