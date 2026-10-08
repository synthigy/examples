#!/usr/bin/env php
<?php

/**
 * Movies demo — the same MovieLens-shaped dataset the other SDKs'
 * examples use, run against a real Synthigy server.
 *
 * Shows three ways to talk to the wire, cheapest first:
 *   1. Raw SDK calls (Synthigy::search/query) — no codegen needed.
 *   2. Generated, typed operations (movies_gen.php) — codegen output.
 *   3. A @batch — list + stats in ONE round trip.
 *
 * Usage:
 *   SYNTHIGY_ENDPOINT=http://localhost:7887 \
 *   SYNTHIGY_CLIENT_ID=... SYNTHIGY_CLIENT_SECRET=... \
 *     php demo.php
 *
 * (or SYNTHIGY_TOKEN=<static token> instead of client id/secret — see
 * sdk/php/README.md's Auth section for what each is for. Regenerate
 * movies_gen.php first if it's missing: see README.md in this directory.)
 */

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';
require __DIR__ . '/generated/movies_gen.php';

use Synthigy\Synthigy;
use Synthigy\SynthigyError;

use function Synthigy\gt;

use Synthigy\Examples\Movies\Batches;
use Synthigy\Examples\Movies\Dashboard;
use Synthigy\Examples\Movies\Movie;

$endpoint = getenv('SYNTHIGY_ENDPOINT') ?: 'http://localhost:7887';
$clientId = getenv('SYNTHIGY_CLIENT_ID') ?: null;
$clientSecret = getenv('SYNTHIGY_CLIENT_SECRET') ?: null;
$token = getenv('SYNTHIGY_TOKEN') ?: null;
// Some servers require an explicit client_credentials audience for /data
// access (opt-in by design — see Client's own $audience doc); set
// SYNTHIGY_AUDIENCE (e.g. https://synthigy.com) if yours does. A static
// SYNTHIGY_TOKEN sidesteps this — audience is already baked into it.
$audience = getenv('SYNTHIGY_AUDIENCE') ?: null;

try {
    Synthigy::connect($endpoint, token: $token, clientId: $clientId, clientSecret: $clientSecret, audience: $audience);
} catch (SynthigyError $e) {
    fwrite(STDERR, "connect failed: {$e->getMessage()} ({$e->code})\n");
    fwrite(STDERR, "set SYNTHIGY_TOKEN, or SYNTHIGY_CLIENT_ID + SYNTHIGY_CLIENT_SECRET (+ SYNTHIGY_AUDIENCE if your server needs one).\n");
    exit(1);
}

function heading(string $text): void
{
    echo "\n\033[1m{$text}\033[0m\n" . str_repeat('-', strlen($text)) . "\n";
}

try {
    // 1) Raw SDK — no codegen, plain search + a filter helper.
    heading('Newest sci-fi/fantasy-ish titles (raw search, no codegen)');
    $rows = Synthigy::search(
        'movie',
        ['release_year' => gt(2000), '_limit' => 3, '_order_by' => [['release_year', 'desc']]],
        ['title' => null, 'release_year' => null],
    );
    foreach ($rows as $row) {
        printf("  %-45s (%d)\n", $row['title'], $row['release_year']);
    }

    // 2) Generated, typed operations.
    heading('Dashboard (generated Dashboard::stats())');
    [$stats] = Dashboard::stats();
    printf("  %d movies, %d ratings (avg %.2f), %d actors\n",
        $stats['total_movies'], $stats['total_ratings'], $stats['avg_rating'] ?? 0.0, $stats['total_actors']);

    heading('Movies since 1990, with genres + rating/actor counts (generated Movie::list())');
    $movies = Movie::list(['since' => 1990, 'limit' => 5]);
    foreach ($movies as $m) {
        $genres = implode(', ', array_column($m['genres'] ?? [], 'name'));
        $avg = $m['_agg']['ratings']['value']['avg'] ?? null;
        printf(
            "  %-45s [%s]\n      %d ratings (avg %s) · %d cast\n",
            "{$m['title']} ({$m['release_year']})",
            $genres !== '' ? $genres : '—',
            $m['_count']['ratings'] ?? 0,
            $avg !== null ? number_format($avg, 2) : 'n/a',
            $m['_count']['actors'] ?? 0,
        );
    }

    if ($movies !== []) {
        heading('One movie in full (generated Movie::detail())');
        $detail = Movie::detail(['xid' => $movies[0]['xid']]);
        printf("  %s (%d)\n", $detail['title'], $detail['release_year']);
        printf("  genres: %s\n", implode(', ', array_column($detail['genres'] ?? [], 'name')));
        printf("  cast:   %s\n", implode(', ', array_slice(array_column($detail['actors'] ?? [], 'name'), 0, 5)));
        printf("  ratings shown: %d\n", count($detail['movie_ratings'] ?? []));
    }

    // 3) @batch — the list + dashboard stats above in ONE wire round trip.
    heading('Same list + stats, but as ONE request (generated Batches::overview())');
    $overview = Batches::overview(['since' => 1990, 'limit' => 5]);
    foreach ($overview as $member => $result) {
        $ok = $result instanceof SynthigyError ? "FAILED: {$result->getMessage()}" : 'ok';
        printf("  %-6s -> %s\n", $member, $ok);
    }
} catch (SynthigyError $e) {
    fwrite(STDERR, "SynthigyError: {$e->getMessage()} (code={$e->code}, category={$e->category})\n");
    exit(1);
}

echo "\n";
