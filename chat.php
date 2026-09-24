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
 * The model is open-weight (gpt-oss-120b) served by Groq's free tier, chosen
 * because it needs no card and allows 1,000 requests and 200,000 tokens a day.
 * The token ceiling is the binding constraint, not the request count: the
 * grounding brief is resent on every call, so a long brief and a long reply
 * together decide how many people the site can actually answer.
 */

declare(strict_types=1);

const MODEL              = 'openai/gpt-oss-120b';
const ENDPOINT           = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_OUTPUT_TOKENS  = 400;   // keeps replies tight and protects the daily token budget
const MAX_INPUT_CHARS    = 600;   // a question, not a pasted document
const MAX_HISTORY_TURNS  = 4;     // enough to follow up, bounded so context cannot grow without limit
const PER_IP_LIMIT       = 12;    // messages per window
const PER_IP_WINDOW      = 900;   // 15 minutes
const DAILY_LIMIT        = 300;   // site-wide, well under the provider's 1,000 so it degrades before they cut us off

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

/* ------------------------------------------------------------------ the key */

function apiKey(): string
{
    $fromEnv = getenv('GROQ_API_KEY');
    if (is_string($fromEnv) && trim($fromEnv) !== '') {
        return trim($fromEnv);
    }

    $docRoot = (string) ($_SERVER['DOCUMENT_ROOT'] ?? __DIR__);

    // One level above the document root: served by nothing, cloned by nothing.
    $path = dirname($docRoot) . '/private/groq.key';
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
    $inWebRoot = $docRoot . '/private/groq.key';
    if (@is_readable($inWebRoot)) {
        fail(
            503,
            'The assistant is not configured correctly.',
            'key found INSIDE the web root at ' . $inWebRoot . ' and was refused. Move it to ' . $path
        );
    }

    fail(503, 'The assistant is not configured yet.', 'no API key in GROQ_API_KEY or ' . $path);
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
 * Counts one hit against a key and reports whether the limit is now exceeded.
 *
 * Flock, not read-then-write. Two visitors arriving together would otherwise
 * both read the same count and both write count+1, so the limit quietly stops
 * being a limit exactly when it matters.
 */
function overLimit(string $name, int $limit, int $windowSeconds): bool
{
    $file = counterDir() . '/' . preg_replace('/[^a-z0-9_.-]/i', '_', $name);
    $handle = @fopen($file, 'c+');
    if ($handle === false) {
        // Cannot count, so cannot enforce. Refusing is the safe direction: an
        // unenforceable limit must not read as an absent one.
        error_log('chat.php: cannot open counter ' . $file);
        return true;
    }

    flock($handle, LOCK_EX);
    $raw = stream_get_contents($handle);
    $state = json_decode($raw ?: '[]', true);
    $now = time();

    if (!is_array($state) || !isset($state['start'], $state['count']) || ($now - (int) $state['start']) > $windowSeconds) {
        $state = ['start' => $now, 'count' => 0];
    }

    $state['count'] = ((int) $state['count']) + 1;

    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, json_encode($state));
    flock($handle, LOCK_UN);
    fclose($handle);

    return $state['count'] > $limit;
}

$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');

if (overLimit('day-' . gmdate('Y-m-d'), DAILY_LIMIT, 86400)) {
    fail(429, 'The assistant has answered as much as it can today. The scenarios and labs on this page cover the same ground, or email ziyad@ziyaduqdah.com.');
}

if (overLimit('ip-' . hash('sha256', $ip), PER_IP_LIMIT, PER_IP_WINDOW)) {
    fail(429, 'That is a lot of questions in a short time. Give it a few minutes, or email ziyad@ziyaduqdah.com.');
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

$payload = json_encode([
    'model'       => MODEL,
    'messages'    => $messages,
    'max_tokens'  => MAX_OUTPUT_TOKENS,
    'temperature' => 0.2,
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

$curl = curl_init(ENDPOINT);
curl_setopt_array($curl, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 30,
    CURLOPT_CONNECTTIMEOUT => 8,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'Authorization: Bearer ' . apiKey(),
    ],
]);

$response = curl_exec($curl);
$status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
$curlError = curl_error($curl);
curl_close($curl);

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
$reply = trim((string) ($decoded['choices'][0]['message']['content'] ?? ''));

if ($reply === '') {
    fail(502, 'The assistant did not return an answer.', 'empty completion: ' . mb_substr((string) $response, 0, 300));
}

echo json_encode([
    'reply' => $reply,
    'model' => MODEL,
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
