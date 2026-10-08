-- Config B overlay: audit triggers. Applied on top of schema.sql.
--
-- Feature-matches Synthigy's audit-by-default substrate: every write fires a
-- per-row AFTER INSERT trigger into a single shared audit table. This is
-- deliberately a CONSERVATIVE match — Synthigy's substrate is attribute-primary
-- (one audit row per changed attribute) and routes through a delta queue +
-- drainer, so it does strictly more per write than this single-row capture.
-- A single shared table also reproduces the rightmost-leaf B-tree hot-page
-- contention that is the documented audit cost.

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  table_name text NOT NULL,
  row_id     text,
  op         text NOT NULL,
  data       jsonb NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION audit_capture() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log(table_name, row_id, op, data)
  VALUES (TG_TABLE_NAME, to_jsonb(NEW) ->> 'id', TG_OP, to_jsonb(NEW));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'movie','movie_genre','movie_actor','app_user',
    'user_rating','user_tag','movie_genre_mapping','movie_actor_mapping'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_audit AFTER INSERT ON %I '
      || 'FOR EACH ROW EXECUTE FUNCTION audit_capture()', t, t);
  END LOOP;
END $$;
