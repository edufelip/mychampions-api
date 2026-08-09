CREATE TABLE IF NOT EXISTS catalog_foods (
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL,
  carbohydrate NUMERIC NOT NULL,
  protein NUMERIC NOT NULL,
  fat NUMERIC NOT NULL,
  serving NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_food_localizations (
  food_id TEXT NOT NULL REFERENCES catalog_foods(id),
  lang TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (food_id, lang)
);

INSERT INTO catalog_foods (id, region, carbohydrate, protein, fat, serving)
VALUES
  ('ci-food-chicken', 'US', 0, 31, 3.6, 100),
  ('ci-food-rice', 'US', 28, 2.7, 0.3, 100),
  ('ci-food-oats', 'US', 66, 17, 7, 100)
ON CONFLICT (id) DO UPDATE SET
  region = EXCLUDED.region,
  carbohydrate = EXCLUDED.carbohydrate,
  protein = EXCLUDED.protein,
  fat = EXCLUDED.fat,
  serving = EXCLUDED.serving;

INSERT INTO catalog_food_localizations (food_id, lang, name)
VALUES
  ('ci-food-chicken', 'en', 'Chicken Breast'),
  ('ci-food-rice', 'en', 'Rice'),
  ('ci-food-oats', 'en', 'Oats')
ON CONFLICT (food_id, lang) DO UPDATE SET name = EXCLUDED.name;
