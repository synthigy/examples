<?php

/**
 * The same movies demo as demo.php, rendered as an HTML page instead of a
 * CLI report — for `php -S` so it's viewable in a browser. Not part of the
 * SDK proper; a convenience view onto the same generated operations.
 *
 * Usage: php -S 0.0.0.0:8899 web.php
 */

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';
require __DIR__ . '/generated/movies_gen.php';

use Synthigy\Synthigy;
use Synthigy\SynthigyError;

use Synthigy\Examples\Movies\Batches;
use Synthigy\Examples\Movies\Dashboard;
use Synthigy\Examples\Movies\Movie;

$endpoint = getenv('SYNTHIGY_ENDPOINT') ?: 'http://localhost:7887';
$clientId = getenv('SYNTHIGY_CLIENT_ID') ?: null;
$clientSecret = getenv('SYNTHIGY_CLIENT_SECRET') ?: null;
$token = getenv('SYNTHIGY_TOKEN') ?: null;
$audience = getenv('SYNTHIGY_AUDIENCE') ?: null;

function h(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES);
}

?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Synthigy PHP SDK — movies demo</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; background: #0d1117; color: #e6edf3; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; border-bottom: 1px solid #30363d; padding-bottom: .3rem; }
  .stats { display: flex; gap: 2rem; margin: 1rem 0; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: .8rem 1.2rem; }
  .stat b { display: block; font-size: 1.6rem; }
  .stat span { color: #8b949e; font-size: .8rem; }
  table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 500; font-size: .8rem; }
  .genre { display: inline-block; background: #1f2937; border-radius: 999px; padding: .1rem .6rem; font-size: .75rem; margin: 0 .2rem .2rem 0; }
  .err { background: #3d1b1b; border: 1px solid #f85149; padding: 1rem; border-radius: 8px; }
  code { background: #161b22; padding: .1rem .4rem; border-radius: 4px; }
</style>
</head>
<body>
<h1>Synthigy PHP SDK — movies demo (live, <code><?= h($endpoint) ?></code>)</h1>

<?php
try {
    Synthigy::connect($endpoint, token: $token, clientId: $clientId, clientSecret: $clientSecret, audience: $audience);

    [$stats] = Dashboard::stats();
    ?>
<div class="stats">
  <div class="stat"><b><?= number_format($stats['total_movies']) ?></b><span>movies</span></div>
  <div class="stat"><b><?= number_format($stats['total_ratings']) ?></b><span>ratings</span></div>
  <div class="stat"><b><?= number_format($stats['avg_rating'] ?? 0, 2) ?></b><span>avg rating</span></div>
  <div class="stat"><b><?= number_format($stats['total_actors']) ?></b><span>actors</span></div>
</div>

<h2>Movies since 1990 (generated <code>Movie::list()</code>)</h2>
<table>
<tr><th>Title</th><th>Year</th><th>Genres</th><th>Ratings</th><th>Cast</th></tr>
<?php foreach (Movie::list(['since' => 1990, 'limit' => 10]) as $m): ?>
<tr>
  <td><?= h($m['title']) ?></td>
  <td><?= (int)$m['release_year'] ?></td>
  <td><?php foreach ($m['genres'] ?? [] as $g) echo '<span class="genre">' . h($g['name']) . '</span>'; ?></td>
  <td><?= $m['_count']['ratings'] ?? 0 ?> (avg <?= isset($m['_agg']['ratings']['value']['avg']) ? number_format($m['_agg']['ratings']['value']['avg'], 2) : 'n/a' ?>)</td>
  <td><?= $m['_count']['actors'] ?? 0 ?></td>
</tr>
<?php endforeach; ?>
</table>

<h2>Same list + stats as ONE request (generated <code>Batches::overview()</code>)</h2>
<?php
    $overview = Batches::overview(['since' => 1990, 'limit' => 10]);
    foreach ($overview as $member => $result) {
        $ok = $result instanceof SynthigyError ? 'FAILED: ' . h($result->getMessage()) : 'ok (' . count($result) . ' item(s))';
        echo '<p><code>' . h($member) . '</code> &rarr; ' . $ok . '</p>';
    }
} catch (SynthigyError $e) {
    echo '<div class="err"><b>' . h($e->code) . '</b>: ' . h($e->getMessage()) . '</div>';
}
?>
</body>
</html>
