#!/usr/bin/env bash
# Rebuild the read-bench backend setup that every schema reset destroys
# (./setup.sh drops tables CASCADE, which takes movie_avg_rating() with it
# because its argument is the movie row type; hasura.mjs's clear_metadata
# wipes the relationships/computed field).
#
# Order matters: fn -> relationships -> computed field (the computed field
# errors if the fn is absent). Run AFTER an import (hasura.mjs tracks tables).
set -euo pipefail
cd "$(dirname "$0")"

docker exec -i bench-postgres psql -U bench -d bench -q <<'SQL'
CREATE OR REPLACE FUNCTION movie_avg_rating(movie_row movie)
RETURNS double precision AS $$
  SELECT avg(r.value)
  FROM user_rating_movie l JOIN user_rating r ON r.id = l.user_rating_id
  WHERE l.movie_id = movie_row.id
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION movie_search()
RETURNS TABLE(title text, genres text[], rating_count bigint,
              avg_rating double precision, top_ratings double precision[]) AS $$
  SELECT m.title,
    COALESCE((SELECT array_agg(g.name ORDER BY g.name)
      FROM movie_genre_mapping gm JOIN movie_genre g ON g.id = gm.genre_id
      WHERE gm.movie_id = m.id), '{}'),
    (SELECT count(*) FROM user_rating_movie l WHERE l.movie_id = m.id),
    (SELECT avg(r.value) FROM user_rating_movie l
      JOIN user_rating r ON r.id = l.user_rating_id WHERE l.movie_id = m.id),
    COALESCE((SELECT array_agg(v) FROM (
      SELECT r.value AS v FROM user_rating_movie l
      JOIN user_rating r ON r.id = l.user_rating_id
      WHERE l.movie_id = m.id ORDER BY r.value DESC LIMIT 3) t), '{}')
  FROM movie m
  WHERE m.release_year > 2000
  ORDER BY m.title
  LIMIT 10
$$ LANGUAGE sql STABLE;
SQL

meta() {
  curl -sf http://localhost:8088/v1/metadata \
    -H 'content-type: application/json' -H 'x-hasura-admin-secret: benchsecret' \
    -d "$1"
}

meta '{"type":"bulk","args":[
  {"type":"pg_create_array_relationship","args":{"source":"default","table":"movie","name":"genre_links","using":{"foreign_key_constraint_on":{"table":"movie_genre_mapping","column":"movie_id"}}}},
  {"type":"pg_create_object_relationship","args":{"source":"default","table":"movie_genre_mapping","name":"genre","using":{"foreign_key_constraint_on":"genre_id"}}},
  {"type":"pg_create_array_relationship","args":{"source":"default","table":"movie","name":"rating_links","using":{"foreign_key_constraint_on":{"table":"user_rating_movie","column":"movie_id"}}}},
  {"type":"pg_create_object_relationship","args":{"source":"default","table":"user_rating_movie","name":"rating","using":{"foreign_key_constraint_on":"user_rating_id"}}}
]}' >/dev/null

meta '{"type":"pg_add_computed_field","args":{"source":"default","table":"movie","name":"avg_rating","definition":{"function":"movie_avg_rating"}}}' >/dev/null

docker exec bench-postgres psql -U bench -d bench -q -c "NOTIFY pgrst, 'reload schema';" >/dev/null
echo "read-bench backend setup applied (movie_avg_rating, movie_search, 4 rels, computed field)"
