-- Benchmark schema. Mirrors the Synthigy "Movies Example" ERD:
--   Movie(title, release_year), MovieGenre(name unique),
--   MovieActor(name unique, birth_year, nationality), User(name, email),
--   UserRating(value, timestamp), UserTag(value, timestamp),
--   m2m movie<->genre, m2m movie<->actor, m2o rating->movie, o2m user->ratings,
--   o2m movie->tags, o2m user->tags.
--
-- PK is Synthigy's nanoid (xid: 22-char Base58), carried directly from the
-- source data as `text` — no synthetic uuid remap. This is the competitor's
-- fast path: FK columns carry the id directly, so there is NO id-resolution
-- step. Synthigy additionally resolves xid->_eid on every write — that
-- structural difference is documented in the results table.

DROP TABLE IF EXISTS user_tag, user_rating, movie_actor_mapping,
  movie_genre_mapping, movie, movie_genre, movie_actor, app_user CASCADE;

CREATE TABLE movie (
  id           text PRIMARY KEY,
  title        text,
  release_year int
);

CREATE TABLE movie_genre (
  id   text PRIMARY KEY,
  name text UNIQUE NOT NULL
);

CREATE TABLE movie_actor (
  id          text PRIMARY KEY,
  name        text UNIQUE NOT NULL,
  birth_year  int,
  nationality text
);

CREATE TABLE app_user (
  id    text PRIMARY KEY,
  name  text,
  email text
);

CREATE TABLE user_rating (
  id        text PRIMARY KEY,
  value     double precision NOT NULL,
  "timestamp" timestamptz,
  movie_id  text NOT NULL REFERENCES movie(id),
  user_id   text NOT NULL REFERENCES app_user(id)
);

CREATE TABLE user_tag (
  id        text PRIMARY KEY,
  value     text NOT NULL,
  "timestamp" timestamptz,
  movie_id  text NOT NULL REFERENCES movie(id),
  user_id   text NOT NULL REFERENCES app_user(id)
);

CREATE TABLE movie_genre_mapping (
  movie_id text NOT NULL REFERENCES movie(id),
  genre_id text NOT NULL REFERENCES movie_genre(id),
  PRIMARY KEY (movie_id, genre_id)
);

CREATE TABLE movie_actor_mapping (
  movie_id text NOT NULL REFERENCES movie(id),
  actor_id text NOT NULL REFERENCES movie_actor(id),
  PRIMARY KEY (movie_id, actor_id)
);

CREATE INDEX ON user_rating (movie_id);
CREATE INDEX ON user_rating (user_id);
CREATE INDEX ON user_tag (movie_id);
CREATE INDEX ON user_tag (user_id);
