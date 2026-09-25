<?php
/**
 * Tests the windowed counters in chat.php.
 *
 * The counters now do arithmetic rather than increment by one, and they decide
 * whether the assistant answers at all. The functions are pulled out of
 * chat.php by pattern rather than copied here, for the same reason
 * dev/test-plain.mjs extracts plain() out of index.html: a copy would let this
 * file go green against code that is not the code being served.
 *
 * Run: docker run --rm -v "$PWD:/app" -w /app php:8.3-cli-alpine php dev/test-budget.php
 */

declare(strict_types=1);

$source = file_get_contents(__DIR__ . '/../chat.php');
if ($source === false) {
    fwrite(STDERR, "cannot read chat.php\n");
    exit(1);
}

/* Constants first: the test asserts against the shipped numbers, not its own. */
$constants = [];
foreach (['TOKENS_PER_DAY', 'TOKENS_PER_MINUTE', 'RESERVE_TOKENS', 'DAILY_LIMIT', 'PER_IP_LIMIT'] as $name) {
    if (!preg_match('/^const\s+' . $name . '\s*=\s*(\d+)\s*;/m', $source, $m)) {
        fwrite(STDERR, "could not find const $name in chat.php\n");
        exit(1);
    }
    $constants[$name] = (int) $m[1];
}

/* The two functions under test, plus the directory helper they need. */
$extracted = '';
foreach (['counterDir', 'bumpWindow', 'overLimit'] as $fn) {
    // From the signature to the closing brace at column 0, which is how every
    // function in chat.php is formatted.
    if (!preg_match('/^function\s+' . $fn . '\s*\(.*?^\}/ms', $source, $m)) {
        fwrite(STDERR, "could not extract $fn() from chat.php\n");
        exit(1);
    }
    $extracted .= $m[0] . "\n\n";
}

/* A test that cannot run must fail, so prove the extraction produced the real
   functions before trusting a single assertion below. */
$tmp = sys_get_temp_dir() . '/zu-budget-test-' . getmypid();
@mkdir($tmp, 0700, true);
putenv('TMPDIR=' . $tmp);
eval($extracted);
foreach (['counterDir', 'bumpWindow', 'overLimit'] as $fn) {
    if (!function_exists($fn)) {
        fwrite(STDERR, "extraction did not define $fn()\n");
        exit(1);
    }
}

$pass = 0;
$fail = 0;

function check(string $what, $actual, $expected): void
{
    global $pass, $fail;
    if ($actual === $expected) {
        $pass++;
        printf("PASS  %s\n", $what);
        return;
    }
    $fail++;
    printf("FAIL  %s\n        expected %s\n        actual   %s\n", $what, var_export($expected, true), var_export($actual, true));
}

$k = fn(string $s): string => $s . '-' . bin2hex(random_bytes(4));

/* ------------------------------------------------ it adds, it does not count */

$a = $k('add');
check('first charge returns the amount', bumpWindow($a, 2800, 60), 2800);
check('second charge accumulates', bumpWindow($a, 2800, 60), 5600);
check('a charge of 0 reads without charging', bumpWindow($a, 0, 60), 5600);

/* This is the bug the old counter had: every call cost 1 regardless of size, so
   300 requests read as 300 against a limit measured in tokens. */
$b = $k('notone');
bumpWindow($b, 5897, 60);
check('a 5,897-token call is not charged as 1', bumpWindow($b, 0, 60), 5897);

/* ------------------------------------------------------------ window expiry */

$c = $k('expire');
bumpWindow($c, 4000, 1);
sleep(2);
check('an expired window starts again at the new charge', bumpWindow($c, 100, 1), 100);

/* --------------------------------------------------------- the request limit */

$d = $k('req');
$results = [];
for ($i = 0; $i < 4; $i++) {
    $results[] = overLimit($d, 3, 60);
}
check('overLimit allows exactly the limit, then refuses', $results, [false, false, false, true]);

/* ------------------------------------------------- fail closed, not fail open */

/* fopen on a directory fails, which is the only way to reach the unwritable
   branch without breaking the filesystem. An unenforceable limit must refuse. */
$dir = $k('isdir');
@mkdir(counterDir() . '/' . $dir, 0700, true);
check('an uncountable key returns null', bumpWindow($dir, 100, 60), null);
check('an uncountable key is over every limit', overLimit($dir, 1000000, 60), true);

/* ------------------------------------------- the ceilings are self-consistent */

check(
    'the daily ceiling leaves room for a reserved call',
    $constants['TOKENS_PER_DAY'] > $constants['RESERVE_TOKENS'],
    true
);
check(
    'the per-minute ceiling leaves room for a reserved call',
    $constants['TOKENS_PER_MINUTE'] > $constants['RESERVE_TOKENS'],
    true
);
/* The reserve is what one worst-case call costs. If it were smaller than a real
   call, the pre-check would wave through a call that then blows past the
   provider's ceiling and the assistant 429s with no local record of why. */
$worstCase = 2664 + (int) ceil((4 * 2 * 1200 + 600) / 3.6) + 400;  // brief + full history + question + output
check(
    'the reserve covers a worst-case call (~' . $worstCase . ' tokens)',
    $constants['RESERVE_TOKENS'] >= $worstCase,
    true
);

/* And the headline finding: the request limit cannot protect a token budget. */
$typicalCall = 2827;
$costOfRequestLimit = $constants['DAILY_LIMIT'] * $typicalCall;
check(
    'the request limit alone would overspend the daily tokens (' . number_format($costOfRequestLimit) . ' > ' . number_format($constants['TOKENS_PER_DAY']) . ')',
    $costOfRequestLimit > $constants['TOKENS_PER_DAY'],
    true
);

/* ---------------------------------------------------------------------- done */

array_map('unlink', glob($tmp . '/zu-chat/*') ?: []);

printf("\n%d/%d passed\n", $pass, $pass + $fail);
exit($fail === 0 ? 0 : 1);
