-- Feature-matched schema. Mirrors Synthigy's data model exactly: EVERY
-- relation is its own junction table — including the m2o `rating → movie`
-- and o2m `movie → tag`, which the default `schema.sql` shortcuts as a plain
-- `movie_id` FK column.
--
-- With this schema the competitors do the same physical work as Synthigy:
-- the same 5 entity tables + 4 junction tables, 244,313 physical rows for
-- the identical logical import. No FK-column shortcut — relations are
-- uniformly queryable in both directions, exactly like Synthigy's model.
-- (app_user is omitted — Synthigy's deployed model has no user relation, so
-- including it would make the competitors do *more* than Synthigy.)
--
-- PK is Synthigy's nanoid (xid: 22-char Base58), carried directly from the
-- source data as `text` — no synthetic uuid remap.

DROP TABLE IF EXISTS user_tag_movie, user_rating_movie, movie_actor_mapping,
  movie_genre_mapping, user_tag, user_rating, movie, movie_genre,
  movie_actor, app_user, audit_log CASCADE;

-- Entities — no relation columns at all.
CREATE TABLE movie (
  id text PRIMARY KEY, title text, release_year int);

CREATE TABLE movie_genre (
  id text PRIMARY KEY, name text UNIQUE NOT NULL);

CREATE TABLE movie_actor (
  id text PRIMARY KEY, name text UNIQUE NOT NULL,
  birth_year int, nationality text);

CREATE TABLE user_rating (
  id text PRIMARY KEY, value double precision NOT NULL,
  "timestamp" timestamptz);

CREATE TABLE user_tag (
  id text PRIMARY KEY, value text NOT NULL,
  "timestamp" timestamptz);

-- Every relation is a junction table.
CREATE TABLE movie_genre_mapping (
  movie_id text NOT NULL REFERENCES movie(id),
  genre_id text NOT NULL REFERENCES movie_genre(id),
  PRIMARY KEY (movie_id, genre_id));

CREATE TABLE movie_actor_mapping (
  movie_id text NOT NULL REFERENCES movie(id),
  actor_id text NOT NULL REFERENCES movie_actor(id),
  PRIMARY KEY (movie_id, actor_id));

CREATE TABLE user_rating_movie (
  user_rating_id text NOT NULL REFERENCES user_rating(id),
  movie_id       text NOT NULL REFERENCES movie(id),
  PRIMARY KEY (user_rating_id, movie_id));

CREATE TABLE user_tag_movie (
  user_tag_id text NOT NULL REFERENCES user_tag(id),
  movie_id    text NOT NULL REFERENCES movie(id),
  PRIMARY KEY (user_tag_id, movie_id));

CREATE INDEX ON movie_genre_mapping (genre_id);
CREATE INDEX ON movie_actor_mapping (actor_id);
CREATE INDEX ON user_rating_movie (movie_id);
CREATE INDEX ON user_tag_movie (movie_id);
