
CREATE TABLE IF NOT EXISTS migration_runs (
  id uuid PRIMARY KEY,
  service text NOT NULL,
  source_redis text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  redis_key_count integer NOT NULL DEFAULT 0,
  normalized_document_count integer NOT NULL DEFAULT 0,
  active_version text,
  notes jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS redis_keys (
  key text PRIMARY KEY,
  redis_type text NOT NULL,
  ttl_ms bigint NOT NULL,
  value jsonb NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id uuid,
  last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS catalog_exercises (
  id text NOT NULL,
  version text NOT NULL,
  slug text,
  muscle_group text,
  secondary_muscles text,
  equipment text,
  category text,
  difficulty text,
  has_video boolean NOT NULL,
  has_video_white boolean NOT NULL,
  has_video_gym boolean NOT NULL,
  video_duration_secs integer,
  exercise_type jsonb NOT NULL,
  video_url text,
  video_hls_url text,
  thumbnail_url text,
  videos jsonb,
  raw_document jsonb NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id uuid,
  last_seen_at timestamptz,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS catalog_exercise_localizations (
  exercise_id text NOT NULL,
  version text NOT NULL,
  lang text NOT NULL,
  title text NOT NULL,
  description text,
  instructions jsonb NOT NULL,
  important_points jsonb NOT NULL,
  status text NOT NULL,
  updated_at timestamptz,
  raw_localization jsonb NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id uuid,
  last_seen_at timestamptz,
  PRIMARY KEY (exercise_id, version, lang)
);

CREATE TABLE IF NOT EXISTS catalog_exercise_localization_statuses (
  exercise_id text NOT NULL,
  version text NOT NULL,
  lang text NOT NULL,
  status text NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id uuid,
  last_seen_at timestamptz,
  PRIMARY KEY (exercise_id, version, lang)
);

CREATE TABLE IF NOT EXISTS catalog_exercise_popularity (
  lang text NOT NULL,
  version text NOT NULL,
  exercise_id text NOT NULL,
  score numeric NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id uuid,
  last_seen_at timestamptz,
  PRIMARY KEY (lang, version, exercise_id)
);

CREATE TABLE IF NOT EXISTS catalog_metadata (
  version text PRIMARY KEY,
  last_synced_at timestamptz,
  exercise_count integer,
  seed_query_count integer,
  successful_seed_queries integer,
  failed_seed_queries integer,
  fetched_rows integer,
  duplicate_rows integer,
  raw_metadata jsonb NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id uuid,
  last_seen_at timestamptz
);

ALTER TABLE redis_keys ADD COLUMN IF NOT EXISTS last_seen_run_id uuid;
ALTER TABLE redis_keys ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE catalog_exercises ADD COLUMN IF NOT EXISTS last_seen_run_id uuid;
ALTER TABLE catalog_exercises ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE catalog_exercise_localizations ADD COLUMN IF NOT EXISTS last_seen_run_id uuid;
ALTER TABLE catalog_exercise_localizations ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE catalog_exercise_localization_statuses ADD COLUMN IF NOT EXISTS last_seen_run_id uuid;
ALTER TABLE catalog_exercise_localization_statuses ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE catalog_exercise_popularity ADD COLUMN IF NOT EXISTS last_seen_run_id uuid;
ALTER TABLE catalog_exercise_popularity ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE catalog_metadata ADD COLUMN IF NOT EXISTS last_seen_run_id uuid;
ALTER TABLE catalog_metadata ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
