<?php
/**
 * Site assistant proxy.
 *
 * The browser cannot hold the API key: anything in page source is public, and
 * an exposed key on a free tier becomes somebody else's inference budget
 * within hours. So the browser talks to this file and this file talks to the
 * provider.
 *
 * The key is never in the repository. It is read from an environment variable
 * or from a file ABOVE the document root, which git cannot reach. See
 * README-chat.md for where to put it.
 *
 * Three providers are wired in, and which one answers is decided by a file
 * next to the key rather than by an edit here (see README-chat.md). Groq
 * serves open-weight gpt-oss-120b on a free tier that allows 1,000 requests
 * and 200,000 tokens a day. Google's Gemini API serves gemini-3.8-flash on a
 * free tier whose limits are not published and whose terms allow the content
 * to be used to improve Google's products. Anthropic serves Claude Haiku 5.5
 * on prepaid credit, at about a twentieth of a cent per question; it is the
 * one provider here that is not a free tier, and the one whose answers do not
 * arrive on a best-effort basis.
 *
 * Groq and Gemini speak the OpenAI chat-completions shape; Anthropic speaks
 * its own Messages shape, and each provider row says which.
 *
 * The token ceiling is the binding constraint, not the request count: the
 * grounding brief is resent on every call, so a long brief and a long reply
 * together decide how many people the site can actually answer.
 */

declare(strict_types=1);

const PROVIDERS = [
    'groq' => [
        'format'           => 'openai',
        'model'            => 'openai/gpt-oss-120b',
        'endpoint'         => 'https://api.groq.com/openai/v1/chat/completions',
        'key_env'          => 'GROQ_API_KEY',
        'key_file'         => 'groq.key',
        // gpt-oss reasons before it answers, and those tokens come out of both
        // the daily allowance and the output ceiling. Grounded lookup needs very
        // little of it and the allowance is the binding constraint.
        'reasoning_effort' => 'low',
    ],
    'gemini' => [
        'format'           => 'openai',
        'model'            => 'gemini-3.8-flash',
        'endpoint'         => 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        'key_env'          => 'GEMINI_API_KEY',
        'key_file'         => 'gemini.key',
        // Gemini 3.8 Flash thinks before it answers and cannot be told not to;
        // 'low' is the least it accepts ('minimal' is rejected by this model).
        'reasoning_effort' => 'low',
    ],
    'anthropic' => [
        'format'           => 'anthropic',
        'model'            => 'claude-haiku-5-5',
        'endpoint'         => 'https://api.anthropic.com/v1/messages',
        'key_env'          => 'ANTHROPIC_API_KEY',
        'key_file'         => 'anthropic.key',
        // Haiku 5.5 thinks adaptively by default and defaults to medium
        // effort; 'low' is the right depth for a lookup, and thinking tokens
        // are billed as output and count against the output ceiling.
        'reasoning_effort' => 'low',
        // Its answers run longer than gpt-oss's for the same question -- the
        // first eval run cut two of seventeen at 400 -- and output is the
        // cheap part of the bill, so the ceiling is higher here.
        'max_output_tokens' => 600,
        // On a free tier the token ceilings below protect the allowance; on
        // prepaid credit they are a cost cap. Claude counts the brief at about
        // 4,900 tokens, so the shared 190,000 a day would be 37 answers. These
        // are roughly 115 answers a day and two a minute, and at Haiku 5.5's
        // rates the day's ceiling is about six cents.
        'tokens_per_day'    => 600000,
        'tokens_per_minute' => 12000,
    ],
];
const DEFAULT_PROVIDER   = 'groq';
const MAX_OUTPUT_TOKENS  = 400;   // keeps replies tight; see the truncation log below before raising it. A provider row may raise it.
const MAX_INPUT_CHARS    = 600;   // a question, not a pasted document
const MAX_HISTORY_TURNS  = 4;     // enough to follow up, bounded so context cannot grow without limit
const PER_IP_LIMIT       = 12;    // messages per window, per visitor
const PER_IP_WINDOW      = 900;   // 15 minutes
const DAILY_LIMIT        = 300;   // site-wide requests, under the provider's 1,000

/*
 * The token ceilings, which are the limits that actually bind.
 *
 * The provider allows 200,000 tokens a day and 8,000 a minute on this tier.
 * Counting requests was never a budget: the grounding brief is resent on every
 * call, so one question costs somewhere near 3,000 tokens and a full follow-up
 * conversation nearer 6,000. DAILY_LIMIT of 300 requests would cost close to a
 * million tokens -- several times the allowance -- so the request counter would
 * never have fired and the assistant would simply have gone dark mid-afternoon
 * with a provider 429 and no explanation.
 *
 * Both ceilings sit below the provider's because a call's cost is known only
 * once it has been made. See the reserve below.
 */
const TOKENS_PER_DAY     = 190000;  // under the provider's 200,000
const TOKENS_PER_MINUTE  = 7000;    // under the provider's 8,000
const RESERVE_TOKENS     = 6000;    // what one worst-case call costs: brief + full history + output

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function fail(int $status, string $message, ?string $detail = null): never
{
    http_response_code($status);
    // $detail is for the server log only. Provider errors can echo request
    // metadata, and this response goes to the public.
    if ($detail !== null) {
        error_log('chat.php: ' . $detail);
    }
    echo json_encode(['error' => $message], JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'Send a POST request.');
}

/* ------------------------------------------------------- the provider */

/** The directory above the document root: served by nothing, cloned by nothing. */
function privateDir(): string
{
    $docRoot = (string) ($_SERVER['DOCUMENT_ROOT'] ?? __DIR__);
    return dirname($docRoot) . '/private';
}

/**
 * Which provider answers. ASSISTANT_PROVIDER in the environment, else the
 * one-word file private/assistant.provider next to the keys, else the default.
 * A name that is not wired in is a configuration error, not a fallback: a
 * typo must not silently route a visitor's question to a different provider.
 */
function providerName(): string
{
    $fromEnv = getenv('ASSISTANT_PROVIDER');
    $name = is_string($fromEnv) && trim($fromEnv) !== '' ? trim($fromEnv) : '';

    if ($name === '') {
        $file = privateDir() . '/assistant.provider';
        if (is_readable($file)) {
            $name = trim((string) file_get_contents($file));
        }
    }

    if ($name === '') {
        return DEFAULT_PROVIDER;
    }
    if (!isset(PROVIDERS[$name])) {
        fail(503, 'The assistant is not configured correctly.', 'unknown provider "' . $name . '"; expected one of ' . implode(', ', array_keys(PROVIDERS)));
    }
    return $name;
}

define('PROVIDER', providerName());
define('MODEL', PROVIDERS[PROVIDER]['model']);
define('ENDPOINT', PROVIDERS[PROVIDER]['endpoint']);
define('REASONING_EFFORT', PROVIDERS[PROVIDER]['reasoning_effort']);
define('FORMAT', PROVIDERS[PROVIDER]['format']);
define('OUTPUT_TOKENS', PROVIDERS[PROVIDER]['max_output_tokens'] ?? MAX_OUTPUT_TOKENS);
define('DAY_TOKENS', PROVIDERS[PROVIDER]['tokens_per_day'] ?? TOKENS_PER_DAY);
define('MINUTE_TOKENS', PROVIDERS[PROVIDER]['tokens_per_minute'] ?? TOKENS_PER_MINUTE);

/* ------------------------------------------------------------------ the key */

function apiKey(): string
{
    $provider = PROVIDERS[PROVIDER];

    $fromEnv = getenv($provider['key_env']);
    if (is_string($fromEnv) && trim($fromEnv) !== '') {
        return trim($fromEnv);
    }

    $docRoot = (string) ($_SERVER['DOCUMENT_ROOT'] ?? __DIR__);

    // One level above the document root: served by nothing, cloned by nothing.
    $path = privateDir() . '/' . $provider['key_file'];
    if (is_readable($path)) {
        $key = trim((string) file_get_contents($path));
        if ($key !== '') {
            return $key;
        }
    }

    // A key inside the web root is refused rather than used.
    //
    // During setup the key was placed in httpdocs/private/. It was not
    // downloadable, but only because the server happened to answer 403 for
    // that path -- incidental protection from a config nobody chose for this
    // purpose and which a vhost template change would quietly remove. Reading
    // it anyway would mean the assistant works perfectly while one server
    // tweak stands between the key and the public, and nothing would ever
    // report that. Refusing makes the insecure arrangement visible instead of
    // comfortable.
    $inWebRoot = $docRoot . '/private/' . $provider['key_file'];
    if (@is_readable($inWebRoot)) {
        fail(
            503,
            'The assistant is not configured correctly.',
            'key found INSIDE the web root at ' . $inWebRoot . ' and was refused. Move it to ' . $path
        );
    }

    fail(503, 'The assistant is not configured yet.', 'no API key in ' . $provider['key_env'] . ' or ' . $path);
}

/* ------------------------------------------------------- rate and budget */

function counterDir(): string
{
    $dir = sys_get_temp_dir() . '/zu-chat';
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    return $dir;
}

/**
 * Adds to a windowed counter and returns the new total, or null if it could not
 * be counted.
 *
 * Flock, not read-then-write. Two visitors arriving together would otherwise
 * both read the same count and both write count+1, so the limit quietly stops
 * being a limit exactly when it matters.
 *
 * An $add of 0 reads the running total without charging for it, which is how
 * the token ceilings are checked before a call whose cost is not yet known.
 */
function bumpWindow(string $name, int $add, int $windowSeconds): ?int
{
    $file = counterDir() . '/' . preg_replace('/[^a-z0-9_.-]/i', '_', $name);
    $handle = @fopen($file, 'c+');
    if ($handle === false) {
        // Cannot count, so cannot enforce. Every caller treats null as over the
        // limit: an unenforceable limit must not read as an absent one.
        error_log('chat.php: cannot open counter ' . $file);
        return null;
    }

    flock($handle, LOCK_EX);
    $raw = stream_get_contents($handle);
    $state = json_decode($raw ?: '[]', true);
    $now = time();

    if (!is_array($state) || !isset($state['start'], $state['count']) || ($now - (int) $state['start']) > $windowSeconds) {
        $state = ['start' => $now, 'count' => 0];
    }

    $state['count'] = ((int) $state['count']) + $add;

    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, json_encode($state));
    flock($handle, LOCK_UN);
    fclose($handle);

    return (int) $state['count'];
}

/** One request charged against a request-count limit. */
function overLimit(string $name, int $limit, int $windowSeconds): bool
{
    $total = bumpWindow($name, 1, $windowSeconds);
    return $total === null || $total > $limit;
}

$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');

if (overLimit('day-' . gmdate('Y-m-d'), DAILY_LIMIT, 86400)) {
    fail(429, 'The assistant has answered as much as it can today. The scenarios and labs on this page cover the same ground, or email ziyad@ziyaduqdah.com.');
}

if (overLimit('ip-' . hash('sha256', $ip), PER_IP_LIMIT, PER_IP_WINDOW)) {
    fail(429, 'That is a lot of questions in a short time. Give it a few minutes, or email ziyad@ziyaduqdah.com.');
}

/*
 * The token ceilings.
 *
 * A call's cost is known only after it returns, so the check here is against
 * what has already been spent plus room for one worst-case call, and the real
 * cost is charged once it is known. A single call can therefore overshoot by
 * less than one call's worth, which is why both ceilings sit below the
 * provider's rather than at them.
 */
$dayKey = 'tok-day-' . gmdate('Y-m-d');
$minKey = 'tok-min-' . gmdate('Y-m-d-H-i');

$daySpent = bumpWindow($dayKey, 0, 86400);
if ($daySpent === null || $daySpent + RESERVE_TOKENS > DAY_TOKENS) {
    fail(
        429,
        'The assistant has answered as much as it can today. The scenarios and labs on this page cover the same ground, or email ziyad@ziyaduqdah.com.',
        'daily token ceiling: ' . var_export($daySpent, true) . ' of ' . DAY_TOKENS . ' spent'
    );
}

$minSpent = bumpWindow($minKey, 0, 60);
if ($minSpent === null || $minSpent + RESERVE_TOKENS > MINUTE_TOKENS) {
    fail(
        429,
        'The assistant is already answering someone else. Try again in a moment, or email ziyad@ziyaduqdah.com.',
        'per-minute token ceiling: ' . var_export($minSpent, true) . ' of ' . MINUTE_TOKENS . ' spent'
    );
}

/* ------------------------------------------------------------------ input */

$body = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($body)) {
    fail(400, 'Expected a JSON body.');
}

$message = trim((string) ($body['message'] ?? ''));
if ($message === '') {
    fail(400, 'Ask a question.');
}
if (mb_strlen($message) > MAX_INPUT_CHARS) {
    fail(400, 'That question is longer than this assistant takes. Try a shorter one.');
}

$brief = @file_get_contents(__DIR__ . '/capability-brief.md');
if ($brief === false || trim($brief) === '') {
    // Without the brief the model has nothing to be grounded by and would
    // answer from its own training, which is exactly the failure this whole
    // design exists to prevent. Refusing beats answering ungrounded.
    fail(503, 'The assistant is unavailable.', 'capability-brief.md missing or empty');
}

$messages = [['role' => 'system', 'content' => $brief]];

// Only the roles this endpoint expects, only the last few turns, and each turn
// truncated. History arrives from the browser and cannot be trusted to be
// small or well-formed.
$history = is_array($body['history'] ?? null) ? $body['history'] : [];
foreach (array_slice($history, -(MAX_HISTORY_TURNS * 2)) as $turn) {
    $role = ($turn['role'] ?? '') === 'assistant' ? 'assistant' : 'user';
    $text = trim((string) ($turn['content'] ?? ''));
    if ($text !== '') {
        $messages[] = ['role' => $role, 'content' => mb_substr($text, 0, 1200)];
    }
}

$messages[] = ['role' => 'user', 'content' => $message];

/* ------------------------------------------------------------------ call */

/**
 * The provider's request body. $messages starts with the brief as a system
 * message, which is how the OpenAI shape wants it; the Anthropic shape takes
 * the brief as a separate field and the turns on their own.
 */
function buildRequest(array $messages): array
{
    if (FORMAT === 'anthropic') {
        $brief = (string) $messages[0]['content'];
        $turns = [];
        foreach (array_slice($messages, 1) as $turn) {
            // The Messages API wants user and assistant to alternate. Two
            // user turns in a row -- a visitor who sent twice before the
            // first answer came -- are joined rather than rejected.
            $last = count($turns) - 1;
            if ($last >= 0 && $turns[$last]['role'] === $turn['role']) {
                $turns[$last]['content'] .= "\n\n" . $turn['content'];
            } else {
                $turns[] = ['role' => $turn['role'], 'content' => $turn['content']];
            }
        }
        return [
            'model'      => MODEL,
            'max_tokens' => OUTPUT_TOKENS,
            // The brief is the same bytes on every call, so it is marked as a
            // cache prefix. Below the model's minimum cacheable size this is a
            // silent no-op, which is fine: it costs nothing either way.
            'system'     => [['type' => 'text', 'text' => $brief, 'cache_control' => ['type' => 'ephemeral']]],
            'messages'   => $turns,
            // Thinking is left at its default (adaptive); the depth is the
            // provider's effort setting. No temperature: this model rejects
            // non-default sampling values, and a grounded lookup at low effort
            // does not need one.
            'output_config' => ['effort' => REASONING_EFFORT],
        ];
    }

    return [
        'model'       => MODEL,
        'messages'    => $messages,
        'max_tokens'  => OUTPUT_TOKENS,
        // Zero, not 0.2. Every answer here is a lookup in the brief, and there is
        // no question on this site whose best answer comes from sampling.
        'temperature' => 0,
        // Both OpenAI-shaped models reason before they answer, and those tokens
        // come out of both the daily allowance and the output ceiling. Grounded
        // lookup needs very little of it; the level is set per provider above.
        'reasoning_effort' => REASONING_EFFORT,
    ];
}

$request = buildRequest($messages);

/**
 * @return array{status:int,body:string|false,error:string}
 */
function callProvider(array $request): array
{
    $curl = curl_init(ENDPOINT);
    curl_setopt_array($curl, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($request, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_HTTPHEADER     => FORMAT === 'anthropic'
            ? ['Content-Type: application/json', 'x-api-key: ' . apiKey(), 'anthropic-version: 2023-06-01']
            : ['Content-Type: application/json', 'Authorization: Bearer ' . apiKey()],
    ]);

    $body = curl_exec($curl);
    $out = [
        'status' => (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE),
        'body'   => $body,
        'error'  => curl_error($curl),
    ];
    curl_close($curl);

    return $out;
}

$result = callProvider($request);

// reasoning_effort is documented for this model on this provider, but it is a
// model-specific parameter and a model swap could make it invalid. A rejected
// parameter would take the assistant down for every visitor, so a 400 that
// names it costs one retry instead: degraded, logged, and still answering.
if (FORMAT === 'openai' && $result['status'] === 400 && is_string($result['body']) && str_contains($result['body'], 'reasoning_effort')) {
    error_log('chat.php: provider rejected reasoning_effort, retrying without it: ' . mb_substr($result['body'], 0, 300));
    unset($request['reasoning_effort']);
    $result = callProvider($request);
}

$response = $result['body'];
$status = $result['status'];
$curlError = $result['error'];

if ($response === false) {
    fail(502, 'The assistant could not be reached. The scenarios above cover the same ground.', 'curl: ' . $curlError);
}

if ($status === 429) {
    fail(429, 'The assistant is rate limited at the moment. Try again shortly, or email ziyad@ziyaduqdah.com.', 'provider 429');
}

if ($status < 200 || $status >= 300) {
    fail(502, 'The assistant is unavailable right now.', 'provider ' . $status . ': ' . mb_substr((string) $response, 0, 500));
}

$decoded = json_decode((string) $response, true);
$usage   = is_array($decoded['usage'] ?? null) ? $decoded['usage'] : [];

if (FORMAT === 'anthropic') {
    // The reply is a list of content blocks. Thinking blocks come first and
    // carry no text by default; only the text blocks are the answer.
    $parts = [];
    foreach (is_array($decoded['content'] ?? null) ? $decoded['content'] : [] as $block) {
        if (($block['type'] ?? '') === 'text') {
            $parts[] = (string) ($block['text'] ?? '');
        }
    }
    $reply = trim(implode('', $parts));

    // Reported in the OpenAI vocabulary so the log, the truncation check and
    // dev/eval.mjs read both providers the same way. 'refusal' is kept as
    // itself: a safety decline is neither a complete answer nor a cut one.
    $finish = match ((string) ($decoded['stop_reason'] ?? '')) {
        'end_turn', 'stop_sequence' => 'stop',
        'max_tokens'                => 'length',
        ''                          => '',
        default                     => (string) $decoded['stop_reason'],
    };

    // Cached prefix tokens are billed at a fraction of the input rate but they
    // are still tokens the call consumed, so they count against the ceiling.
    $promptTokens     = (int) ($usage['input_tokens'] ?? 0)
        + (int) ($usage['cache_read_input_tokens'] ?? 0)
        + (int) ($usage['cache_creation_input_tokens'] ?? 0);
    $completionTokens = (int) ($usage['output_tokens'] ?? 0);
    $reasoningTokens  = 0; // thinking is inside output_tokens and not reported separately
    $totalTokens      = $promptTokens + $completionTokens;
} else {
    $reply   = trim((string) ($decoded['choices'][0]['message']['content'] ?? ''));
    $finish  = (string) ($decoded['choices'][0]['finish_reason'] ?? '');

    $promptTokens     = (int) ($usage['prompt_tokens'] ?? 0);
    $completionTokens = (int) ($usage['completion_tokens'] ?? 0);
    $reasoningTokens  = (int) ($usage['completion_tokens_details']['reasoning_tokens'] ?? 0);
    $totalTokens      = (int) ($usage['total_tokens'] ?? 0);
}

// A call whose cost could not be read is charged the reserve, not nothing. It
// consumed the provider's allowance either way, and treating an unmeasured cost
// as free is how a budget quietly stops being one.
$charge = $totalTokens > 0 ? $totalTokens : RESERVE_TOKENS;
$dayNow = bumpWindow($dayKey, $charge, 86400);
$minNow = bumpWindow($minKey, $charge, 60);

error_log(sprintf(
    'chat.php usage: provider=%s prompt=%d completion=%d reasoning=%d total=%d%s finish=%s day=%s/%d minute=%s/%d',
    PROVIDER,
    $promptTokens,
    $completionTokens,
    $reasoningTokens,
    $totalTokens,
    $totalTokens > 0 ? '' : ' (UNREAD, charged ' . RESERVE_TOKENS . ')',
    $finish === '' ? 'none' : $finish,
    $dayNow === null ? '?' : (string) $dayNow,
    DAY_TOKENS,
    $minNow === null ? '?' : (string) $minNow,
    MINUTE_TOKENS
));

// Truncation is invisible in the reply itself -- a sentence cut at the ceiling
// reads like a sentence that ended. This is the only signal that says the
// ceiling is too low rather than the model being terse, and because reasoning
// tokens share that ceiling it is the number to check before raising it.
if ($finish === 'length') {
    error_log('chat.php: reply TRUNCATED at max_tokens=' . OUTPUT_TOKENS
        . ' (completion=' . $completionTokens . ', of which reasoning=' . $reasoningTokens . ')');
}

if ($reply === '') {
    fail(
        502,
        'The assistant did not return an answer.',
        'empty completion, finish_reason=' . ($finish === '' ? 'none' : $finish)
            . ', completion_tokens=' . $completionTokens . ', reasoning_tokens=' . $reasoningTokens
            . ': ' . mb_substr((string) $response, 0, 300)
    );
}

echo json_encode([
    'reply' => $reply,
    'provider' => PROVIDER,
    'model' => MODEL,
    // Diagnostics rather than secrets: they carry no content, and without them
    // a truncated reply is indistinguishable from a complete one. dev/eval.mjs
    // grades against these.
    'finish_reason' => $finish,
    'usage' => [
        'prompt_tokens'     => $promptTokens,
        'completion_tokens' => $completionTokens,
        'reasoning_tokens'  => $reasoningTokens,
        'total_tokens'      => $totalTokens,
    ],
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
