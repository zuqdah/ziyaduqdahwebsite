<?php
/**
 * TEMPORARY setup diagnostic. DELETE THIS FILE once the assistant works.
 *
 * It exists to answer one question: why can chat.php not read the key? The
 * candidates are the path, the file permissions, and Plesk's open_basedir
 * restriction, and they are indistinguishable from the outside.
 *
 * It never reads, prints, or hashes the key itself. It reports only where the
 * server is looking and whether something is there -- filesystem paths, which
 * are mildly sensitive and the reason this file is short-lived rather than
 * permanent.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$docRoot = (string) ($_SERVER['DOCUMENT_ROOT'] ?? '');
$expected = dirname($docRoot) . '/private/groq.key';

// Where else somebody might reasonably have put it, so the answer is "it is
// here instead" rather than another round trip.
$alternatives = [
    $docRoot . '/private/groq.key',
    $docRoot . '/../groq.key',
    dirname($docRoot) . '/groq.key',
    dirname($docRoot) . '/private/groq.txt',
];

$found = [];
foreach ($alternatives as $path) {
    if (@file_exists($path)) {
        $found[] = $path;
    }
}

$parent = dirname($docRoot);

echo json_encode([
    'document_root'        => $docRoot,
    'expected_key_path'    => $expected,
    'expected_exists'      => @file_exists($expected),
    'expected_readable'    => @is_readable($expected),
    // Zero would mean the file is there but empty, which looks identical to
    // "missing" from chat.php's point of view.
    'expected_size_bytes'  => @file_exists($expected) ? @filesize($expected) : null,
    'parent_dir'           => $parent,
    'parent_listable'      => @is_readable($parent),
    'private_dir_exists'   => @is_dir($parent . '/private'),
    'env_var_set'          => getenv('GROQ_API_KEY') !== false,
    // The usual culprit: Plesk confines PHP to the web root, so a file placed
    // correctly above it is still unreadable.
    'open_basedir'         => ini_get('open_basedir') ?: '(not set)',
    'php_user'             => function_exists('posix_getpwuid') && function_exists('posix_geteuid')
        ? (posix_getpwuid(posix_geteuid())['name'] ?? 'unknown')
        : 'unknown',
    'found_elsewhere'      => $found,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
