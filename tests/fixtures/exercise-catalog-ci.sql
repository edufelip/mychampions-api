CREATE TABLE IF NOT EXISTS catalog_exercises (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  description TEXT,
  instructions JSONB,
  important_points JSONB,
  muscle_group TEXT NOT NULL,
  secondary_muscles TEXT,
  equipment TEXT NOT NULL,
  category TEXT,
  difficulty TEXT,
  exercise_type JSONB,
  has_video BOOLEAN NOT NULL,
  has_video_white BOOLEAN NOT NULL,
  has_video_gym BOOLEAN NOT NULL,
  videos JSONB,
  video_url TEXT,
  video_hls_url TEXT,
  thumbnail_url TEXT,
  video_duration_secs NUMERIC
);

CREATE TABLE IF NOT EXISTS catalog_exercise_localizations (
  exercise_id TEXT NOT NULL REFERENCES catalog_exercises(id),
  lang TEXT NOT NULL,
  title TEXT,
  description TEXT,
  instructions JSONB,
  important_points JSONB,
  PRIMARY KEY (exercise_id, lang)
);

INSERT INTO catalog_exercises (
  id, slug, description, instructions, important_points, muscle_group,
  secondary_muscles, equipment, category, difficulty, exercise_type,
  has_video, has_video_white, has_video_gym, videos, video_url,
  video_hls_url, thumbnail_url, video_duration_secs
)
VALUES
  ('ci-exercise-squat', 'squat', 'A squat exercise', '["Stand tall"]', '["Keep your core braced"]', 'legs', 'glutes', 'barbell', 'strength', 'beginner', '["compound"]', false, false, false, '[]', NULL, NULL, NULL, NULL),
  ('ci-exercise-pushup', 'push-up', 'A push-up exercise', '["Start in plank"]', '["Keep a straight line"]', 'chest', 'triceps', 'bodyweight', 'strength', 'beginner', '["compound"]', false, false, false, '[]', NULL, NULL, NULL, NULL),
  ('ci-exercise-row', 'row', 'A row exercise', '["Pull to your ribs"]', '["Control the return"]', 'back', 'biceps', 'dumbbell', 'strength', 'beginner', '["compound"]', false, false, false, '[]', NULL, NULL, NULL, NULL)
ON CONFLICT (id) DO UPDATE SET
  slug = EXCLUDED.slug,
  description = EXCLUDED.description,
  instructions = EXCLUDED.instructions,
  important_points = EXCLUDED.important_points,
  muscle_group = EXCLUDED.muscle_group,
  secondary_muscles = EXCLUDED.secondary_muscles,
  equipment = EXCLUDED.equipment,
  category = EXCLUDED.category,
  difficulty = EXCLUDED.difficulty,
  exercise_type = EXCLUDED.exercise_type,
  has_video = EXCLUDED.has_video,
  has_video_white = EXCLUDED.has_video_white,
  has_video_gym = EXCLUDED.has_video_gym,
  videos = EXCLUDED.videos,
  video_url = EXCLUDED.video_url,
  video_hls_url = EXCLUDED.video_hls_url,
  thumbnail_url = EXCLUDED.thumbnail_url,
  video_duration_secs = EXCLUDED.video_duration_secs;

INSERT INTO catalog_exercise_localizations (
  exercise_id, lang, title, description, instructions, important_points
)
VALUES
  ('ci-exercise-squat', 'en', 'Squat', 'English squat', '["Stand tall"]', '["Brace"]'),
  ('ci-exercise-squat', 'pt', 'Agachamento', 'Agachamento em portugues', '["Fique em pe"]', '["Contraia o core"]'),
  ('ci-exercise-squat', 'es', 'Sentadilla', 'Sentadilla en espanol', '["Ponte de pie"]', '["Manten el core"]'),
  ('ci-exercise-pushup', 'en', 'Push Up', 'English push up', '["Start in plank"]', '["Align"]'),
  ('ci-exercise-pushup', 'pt', 'Flexao', 'Flexao em portugues', '["Comece em prancha"]', '["Alinhe"]'),
  ('ci-exercise-pushup', 'es', 'Flexion', 'Flexion en espanol', '["Empieza en plancha"]', '["Alinena"]'),
  ('ci-exercise-row', 'en', 'Row', 'English row', '["Pull"]', '["Control"]'),
  ('ci-exercise-row', 'pt', 'Remada', 'Remada em portugues', '["Puxe"]', '["Controle"]'),
  ('ci-exercise-row', 'es', 'Remo', 'Remo en espanol', '["Tira"]', '["Controla"]')
ON CONFLICT (exercise_id, lang) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  instructions = EXCLUDED.instructions,
  important_points = EXCLUDED.important_points;
