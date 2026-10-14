
CREATE TABLE IF NOT EXISTS migration_runs (
  id uuid PRIMARY KEY,
  service text NOT NULL,
  source_redis text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  redis_key_count integer NOT NULL DEFAULT 0,
  normalized_document_count integer NOT NULL DEFAULT 0,
  active_generation text,
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

CREATE TABLE IF NOT EXISTS catalog_foods (
  id text PRIMARY KEY,
  carbohydrate numeric NOT NULL,
  protein numeric NOT NULL,
  fat numeric NOT NULL,
  serving numeric NOT NULL,
  region text,
  source text,
  raw_document jsonb NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id uuid,
  last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS catalog_food_localizations (
  food_id text NOT NULL REFERENCES catalog_foods(id) ON DELETE CASCADE,
  lang text NOT NULL,
  name text NOT NULL,
  review_status text NOT NULL,
  updated_at timestamptz,
  raw_localization jsonb NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id uuid,
  last_seen_at timestamptz,
  PRIMARY KEY (food_id, lang)
);

CREATE TABLE IF NOT EXISTS catalog_food_localization_statuses (
  food_id text NOT NULL,
  lang text NOT NULL,
  status text NOT NULL,
  reviewer_id text,
  updated_at timestamptz,
  raw_status jsonb NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id uuid,
  last_seen_at timestamptz,
  PRIMARY KEY (food_id, lang)
);

CREATE TABLE IF NOT EXISTS catalog_food_popularity (
  index_version text NOT NULL,
  generation text NOT NULL,
  lang text NOT NULL,
  region text NOT NULL,
  food_id text NOT NULL,
  score numeric NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id uuid,
  last_seen_at timestamptz,
  PRIMARY KEY (index_version, generation, lang, region, food_id)
);

CREATE TABLE IF NOT EXISTS catalog_metadata (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id uuid,
  last_seen_at timestamptz
);

ALTER TABLE redis_keys ADD COLUMN IF NOT EXISTS last_seen_run_id uuid;
ALTER TABLE redis_keys ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE catalog_foods ADD COLUMN IF NOT EXISTS last_seen_run_id uuid;
ALTER TABLE catalog_foods ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE catalog_food_localizations ADD COLUMN IF NOT EXISTS last_seen_run_id uuid;
ALTER TABLE catalog_food_localizations ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE catalog_food_localization_statuses ADD COLUMN IF NOT EXISTS last_seen_run_id uuid;
ALTER TABLE catalog_food_localization_statuses ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE catalog_food_popularity ADD COLUMN IF NOT EXISTS last_seen_run_id uuid;
ALTER TABLE catalog_food_popularity ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE catalog_metadata ADD COLUMN IF NOT EXISTS last_seen_run_id uuid;
ALTER TABLE catalog_metadata ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
