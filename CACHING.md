# Cache policy

## The problem this fixes

The site shipped with **no `Cache-Control` header on HTML** — only `Last-Modified`
and `ETag`. With no explicit directive a browser is free to invent a freshness
lifetime, and most use a heuristic of roughly a tenth of the document's age. So
a returning visitor can hold a stale homepage for hours after it changes, with
nothing to tell them and no way to know.

That is not theoretical. A published update to this site looked like a failed
deployment for exactly this reason: the server had the new file, and the browser
would not ask for it.

It also hid itself from testing. Every check made against the site used a
cache-busting query string, which is precisely the request a browser never
makes. The server looked correct because the only request that could have shown
the problem was the one never sent. **The bare `/` with default caching is the
request that matters.**

## Why this is nginx and not `.htaccess`

Plesk here runs **nginx in front of Apache** with static-file processing on.
nginx serves `.html`, `.md` and `.pdf` itself and never consults Apache, so an
`.htaccess` `Header set Cache-Control` would have no effect on the homepage
while looking exactly like a fix.

This is provable from the ETag formats, without any server access:

| Served by | ETag format | Example |
|---|---|---|
| nginx | `"<hex mtime>-<hex size>"` | `/` → `"6ab4d327-e149"` |
| Apache | `"<hex size>-<hex mtime>"` | 404 page → `"328-63681e84e3fe5"` |

`0xe149` is 57673, which matched `Content-Length` on the homepage, and
`0x6ab4d327` is 1790235431, which matched its `Last-Modified`. The homepage
carries the nginx ETag; `.htaccess` is not in its path.

`chat.php` is the exception — PHP reaches Apache, and its own `no-store` header
is already present in responses.

## The directives

Plesk → **Domains → ziyaduqdah.com → Apache & nginx Settings → Additional nginx
directives**, then Apply.

```nginx
# Cache policy. See CACHING.md in the site repository.
#
# Exact-match locations are deliberate. nginx resolves "=" locations before any
# regex location, so these apply regardless of where Plesk inserts this block
# relative to its own generated rules -- there is no ordering question to get
# wrong. The cost is that filenames are hardcoded, which is fine for a site of
# three static files and is noted in CACHING.md so it gets revisited.
#
# The bare "/" needs its own block and does NOT come along for free. The first
# version of this assumed nginx resolves "/" to /index.html via the index
# directive and re-runs location matching, landing in "location = /index.html".
# It does not. That is measured rather than reasoned: with the exact matches
# applied, /index.html carried the header and "/" did not. So "/" gets its own
# location, and uses try_files rather than index so that index.html is served
# INSIDE that location and the header is guaranteed to apply.
#
# "always" is load-bearing. Without it nginx omits add_header on 304 responses,
# and 304 is exactly what revalidation produces -- the header would appear on
# the first request and vanish on every one after it.

location = / {
    add_header Cache-Control "no-cache, must-revalidate" always;
    try_files /index.html =404;
}

location = /index.html {
    add_header Cache-Control "no-cache, must-revalidate" always;
}

location = /Ziyad_Uqdah_Resume.pdf {
    add_header Cache-Control "no-cache, must-revalidate" always;
}

# Markdown in the web root is documentation and the assistant's grounding
# brief. Nothing on the page links to any of it and nothing needs to be served:
# chat.php reads capability-brief.md off the local filesystem via __DIR__, not
# over HTTP, so denying it changes nothing about how the assistant works.
#
# Serving them leaked the API key's server path, the exact rate-limit values and
# these notes to anyone who guessed a filename. This file caused that: it was
# created inside the web root without considering that the web root is served.
#
# The exact matches are guaranteed to beat any regex location Plesk generates.
# The regex is a catch-all for markdown added later, which works unless ordering
# defeats it -- in which case the exact matches still cover what exists.
location = /capability-brief.md { deny all; }
location = /README-chat.md      { deny all; }
location = /CACHING.md          { deny all; }
location ~* \.md$               { deny all; }

# Backstop only. The key belongs above the document root and chat.php refuses to
# read one from inside it. This covers the case where a key file lands in
# httpdocs by mistake.
location ~* \.(key|pem|env)$ {
    deny all;
}

# Support material that is not part of the site. "^~" beats every regex
# location, same principle as the exact matches above.
#
# The repository root IS the web root here -- Plesk deploys straight into
# httpdocs -- so every file committed becomes a URL, which is how CACHING.md
# became a public page. One rule for a directory is the durable version of that
# fix; denying each new file by name is not.
location ^~ /dev/ {
    deny all;
}
```

The page itself needs exactly three local files — `index.html`, `chat.php` and
`Ziyad_Uqdah_Resume.pdf` — plus the GitHub API, which is external. Everything
else in the repository is support material and belongs in `dev/`.

## Why `no-cache` and not a short `max-age`

`no-cache` does **not** mean "do not store". The browser keeps the file and
revalidates before using it, so an unchanged page costs a 304 and a few bytes
rather than a full 57 KB download. The page is never stale and is barely slower.

A short `max-age` would have been the other option, but it trades a guarantee
for a window: during that window a visitor sees the old page and no amount of
reloading tells them so. For a career site read by people who may look exactly
once, being current beats being fast by a margin that is not close.

The resume PDF is included for the same reason. It is a **fixed filename whose
contents change** with each new version, so caching it by name means somebody
downloads last quarter's copy believing it is current. It is fetched rarely, so
revalidation costs nothing worth having.

## Verifying it

The check must be a plain request with default caching. A cache-buster proves
nothing, because it is not the request a visitor makes.

**Check `/` and `/index.html` separately.** They are different requests to
nginx and the first round of this got one right and the other wrong. `/` is the
one a visitor actually sends; `/index.html` passing is not evidence that it
does.

```bash
curl -sSI https://ziyaduqdah.com/ | grep -i cache-control
```

Expected: `Cache-Control: no-cache, must-revalidate`

Then confirm revalidation returns the header on a 304 as well, which is what
`always` exists for:

```bash
curl -sSI https://ziyaduqdah.com/ -H 'If-None-Match: "6ab4d327-e149"' | grep -iE "HTTP|cache-control"
```

Expected: `304` **and** the `Cache-Control` line. If the status is 304 but the
header is missing, `always` was dropped.

## If a file is added to the site

These are exact-match locations, so a new static file gets no cache policy until
it is added to the block above. That is the trade taken for immunity to location
ordering. If the site grows past a handful of files, replace the exact matches
with a single regex location and verify the ordering against Plesk's generated
config rather than assuming it.

## Verifying the denies

```bash
for p in /capability-brief.md /README-chat.md /CACHING.md /anything-new.md \
         /test.key /x.env; do
  printf "%-24s " "$p"
  curl -sS -o /dev/null -w "%{http_code}\n" "https://ziyaduqdah.com$p"
done
```

All six should be `403`. `/anything-new.md` does not exist and is there to prove
the catch-all regex is reached rather than the response merely being a 404 in
disguise.

Then confirm the assistant still answers, since the brief it depends on is now
denied over HTTP:

```bash
curl -sS -X POST https://ziyaduqdah.com/chat.php \
  -H "Content-Type: application/json" \
  --data '{"message":"Which lab measured recovery time, and how?"}'
```

A grounded answer naming `disaster-recovery-actually-failed-over` means the
filesystem read is unaffected, which is the whole basis for denying it.

## A note on where this policy lives

These directives are in **Plesk, not this repository**, so they do not travel
with a git deploy. If the site is migrated or the vhost is rebuilt, the block
has to be pasted back and nothing will warn anyone: the symptom is the stale-page
problem quietly returning and the markdown files quietly becoming public again.
