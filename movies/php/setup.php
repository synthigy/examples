<?php

declare(strict_types=1);

/**
 * Deploy the movies model and seed ml-latest-small — run once, before codegen:
 *
 *   synthigy exec -- composer setup
 *
 * The same deploy and the same rows as the JS port's `npm run setup`.
 */

require __DIR__ . '/vendor/autoload.php';

use Synthigy\Synthigy;

ini_set('memory_limit', '1G'); // ml-latest-small's 100k ratings, decoded

const DATASETS = __DIR__ . '/../../datasets/movies';

function load(string $name): array
{
    return json_decode((string)file_get_contents(DATASETS . "/movies/{$name}.json"), true, flags: JSON_THROW_ON_ERROR);
}

function pick(array $r, string ...$keys): array
{
    return array_combine($keys, array_map(fn($k) => $r[$k] ?? null, $keys));
}

function xidRefs(array $movies): array
{
    return array_map(fn($m) => ['xid' => $m['xid']], $movies);
}

/** The raw files, shaped the way the model declares them. */
function phases(): array
{
    $genres = array_map(fn($g) => pick($g, 'xid', 'name'), load('movie_genres'));
    $genreLinks = array_map(fn($g) => ['xid' => $g['xid'], 'movies' => xidRefs($g['movies'])], load('movie_genres_mapping'));

    // Actors dedupe on Name (UNIQUE); links of a dropped duplicate follow the kept row.
    $kept = [];
    $remap = [];
    foreach (load('movie_actors') as $a) {
        if (isset($kept[$a['name']])) {
            $remap[$a['xid']] = $kept[$a['name']]['xid'];
        } else {
            $kept[$a['name']] = pick($a, 'xid', 'name', 'avatar', 'birth_year', 'nationality');
        }
    }
    $links = [];
    foreach (load('movie_actors_mapping') as $a) {
        $xid = $remap[$a['xid']] ?? $a['xid'];
        $links[$xid] ??= ['xid' => $xid, 'movies' => []];
        $seen = array_column($links[$xid]['movies'], 'xid', 'xid');
        foreach (xidRefs($a['movies']) as $m) {
            if (!isset($seen[$m['xid']])) {
                $links[$xid]['movies'][] = $m;
                $seen[$m['xid']] = true;
            }
        }
    }

    $movies = array_map(fn($m) => pick($m, 'xid', 'title', 'release_year', 'poster'), load('movies'));
    $strip = fn($r) => ['xid' => $r['xid'], 'value' => $r['value'], 'timestamp' => $r['timestamp'] ?? null,
        'movie' => ['xid' => $r['movie']['xid']]];

    return [
        ['Movie Genre', $genres],
        ['Movie Actor', array_values($kept)],
        ['Movie', $movies],
        ['Movie Genre', $genreLinks],
        ['Movie Actor', array_values($links)],
        ['User Rating', array_map($strip, load('user_ratings'))],
        ['User Tag', array_map($strip, load('user_tags'))],
    ];
}

Synthigy::connect(
    getenv('SYNTHIGY_ENDPOINT') ?: null,
    clientId: getenv('SYNTHIGY_CLIENT_ID') ?: null,
    clientSecret: getenv('SYNTHIGY_CLIENT_SECRET') ?: null,
    timeoutSeconds: 300,
);

$ack = Synthigy::deploy((string)file_get_contents(DATASETS . '/Movies Example@0.4.json'));
echo "deployed {$ack['version']} (dataset {$ack['dataset']})\n";

foreach (phases() as [$entity, $rows]) {
    foreach (array_chunk($rows, 500) as $chunk) {
        Synthigy::sync($entity, $chunk);
    }
    echo "seeded {$entity}: " . count($rows) . "\n";
}
