import postgres from 'postgres';

import { parseExerciseQuery } from './exercise-query';
import { rankAndCapCandidates } from './exercise-candidates';

export type ExerciseVideo = {
  videoUrl?: string;
  videoHlsUrl?: string;
  thumbnailUrl?: string;
  tag?: 'white-background' | 'gym-shot';
  orientation?: 'landscape' | 'portrait';
  isPrimary?: boolean;
};

export type ExerciseItem = {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  instructions?: string[] | null;
  importantPoints?: string[] | null;
  muscleGroup: string;
  secondaryMuscles?: string[] | null;
  equipment: string;
  category?: string | null;
  difficulty?: string | null;
  exerciseType?: string[] | null;
  hasVideo: boolean;
  hasVideoWhite: boolean;
  hasVideoGym: boolean;
  videos?: ExerciseVideo[] | null;
  videoUrl?: string | null;
  videoHlsUrl?: string | null;
  thumbnailUrl?: string | null;
  videoDurationSecs?: number | null;
};

export type ExerciseSearchInput = {
  authUid: string;
  query: string;
  pageSize: number;
  lang: string;
};

export type ExerciseDetailInput = {
  authUid: string;
  id: string;
  lang: string;
};

export type ExerciseSearchResult = {
  page: number;
  pageSize: number;
  total: number;
  exercises: ExerciseItem[];
};

export type ExerciseSearchGateway = {
  search(input: ExerciseSearchInput): Promise<ExerciseSearchResult>;
  getById(input: ExerciseDetailInput): Promise<ExerciseItem | null>;
};

export type ExerciseSearchGatewayOptions = {
  v2Enabled?: boolean;
};

export class ExerciseSearchGatewayError extends Error {
  code: 'configuration' | 'upstream';

  constructor(code: 'configuration' | 'upstream', message: string) {
    super(message);
    this.code = code;
    this.name = 'ExerciseSearchGatewayError';
  }
}

type ExerciseCatalogRow = {
  id: string;
  slug: string;
  title: string | null;
  description: string | null;
  instructions: unknown;
  important_points: unknown;
  muscle_group: string;
  secondary_muscles: string | null;
  equipment: string;
  category: string | null;
  difficulty: string | null;
  exercise_type: unknown;
  has_video: boolean;
  has_video_white: boolean;
  has_video_gym: boolean;
  videos: unknown;
  video_url: string | null;
  video_hls_url: string | null;
  thumbnail_url: string | null;
  video_duration_secs: number | null;
};

function normalizeLang(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower.startsWith('pt')) return 'pt';
  if (lower.startsWith('es')) return 'es';
  return 'en';
}

function stringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return strings.length > 0 ? strings : null;
  }
  return null;
}

function splitSecondaryMuscles(value: string | null): string[] | null {
  if (!value?.trim()) return null;
  const parts = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function videoArray(value: unknown): ExerciseVideo[] | null {
  if (!Array.isArray(value)) return null;
  const videos = value.filter((item): item is ExerciseVideo => Boolean(item) && typeof item === 'object');
  return videos.length > 0 ? videos : null;
}

function exerciseFromRow(row: ExerciseCatalogRow): ExerciseItem {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title?.trim() || row.slug,
    description: row.description,
    instructions: stringArray(row.instructions),
    importantPoints: stringArray(row.important_points),
    muscleGroup: row.muscle_group,
    secondaryMuscles: splitSecondaryMuscles(row.secondary_muscles),
    equipment: row.equipment,
    category: row.category,
    difficulty: row.difficulty,
    exerciseType: stringArray(row.exercise_type),
    hasVideo: row.has_video,
    hasVideoWhite: row.has_video_white,
    hasVideoGym: row.has_video_gym,
    videos: videoArray(row.videos),
    videoUrl: row.video_url,
    videoHlsUrl: row.video_hls_url,
    thumbnailUrl: row.thumbnail_url,
    videoDurationSecs: row.video_duration_secs,
  };
}

export class PostgresExerciseSearchGateway implements ExerciseSearchGateway {
  private readonly sql: postgres.Sql | null;
  private readonly v2Enabled: boolean;

  constructor(databaseUrl: string | null, options: ExerciseSearchGatewayOptions = {}) {
    this.sql = databaseUrl ? postgres(databaseUrl, { max: 3 }) : null;
    this.v2Enabled = options.v2Enabled === true;
  }

  async search(input: ExerciseSearchInput): Promise<ExerciseSearchResult> {
    if (!this.sql) {
      throw new ExerciseSearchGatewayError('configuration', 'Exercise catalog database is not configured.');
    }

    const query = input.query.trim();
    const lang = normalizeLang(input.lang);

    try {
      if (this.v2Enabled) {
        return await this.searchV2(input, query, lang);
      }

      const pattern = `%${query}%`;
      const prefixPattern = `${query}%`;
      const rows = await this.sql<ExerciseCatalogRow[]>`
        SELECT
          e.id,
          e.slug,
          COALESCE(localized.title, english.title, e.slug) AS title,
          COALESCE(localized.description, english.description) AS description,
          COALESCE(localized.instructions, english.instructions) AS instructions,
          COALESCE(localized.important_points, english.important_points) AS important_points,
          e.muscle_group,
          e.secondary_muscles,
          e.equipment,
          e.category,
          e.difficulty,
          e.exercise_type,
          e.has_video,
          e.has_video_white,
          e.has_video_gym,
          e.videos,
          e.video_url,
          e.video_hls_url,
          e.thumbnail_url,
          e.video_duration_secs
        FROM catalog_exercises e
        LEFT JOIN catalog_exercise_localizations localized
          ON localized.exercise_id = e.id
          AND localized.lang = ${lang}
        LEFT JOIN catalog_exercise_localizations english
          ON english.exercise_id = e.id
          AND english.lang = 'en'
        WHERE
          ${query === ''}
          OR localized.title ILIKE ${pattern}
          OR english.title ILIKE ${pattern}
          OR e.slug ILIKE ${pattern}
          OR e.muscle_group ILIKE ${pattern}
          OR e.equipment ILIKE ${pattern}
        ORDER BY
          CASE
            WHEN lower(COALESCE(localized.title, english.title, e.slug)) = lower(${query}) THEN 0
            WHEN COALESCE(localized.title, english.title, e.slug) ILIKE ${prefixPattern} THEN 1
            ELSE 2
          END,
          COALESCE(localized.title, english.title, e.slug) ASC,
          e.id ASC
        LIMIT ${input.pageSize}
      `;

      const exercises = rows.map(exerciseFromRow);
      return {
        page: 1,
        pageSize: input.pageSize,
        total: exercises.length,
        exercises,
      };
    } catch (error) {
      throw new ExerciseSearchGatewayError(
        'upstream',
        error instanceof Error ? error.message : 'Exercise catalog search failed.'
      );
    }
  }

  private async searchV2(
    input: ExerciseSearchInput,
    query: string,
    lang: string,
  ): Promise<ExerciseSearchResult> {
    const parsed = parseExerciseQuery(query);
    if (!parsed.normalized) {
      return { page: 1, pageSize: input.pageSize, total: 0, exercises: [] };
    }
    const patterns = Array.from({ length: 12 }, (_, index) => {
      const token = parsed.tokens[index];
      if (!token) return '%\\u0000%';
      const escaped = token.replace(/[\\%_]/g, (character) => `\\${character}`);
      return `%${escaped}%`;
    });

    // The fixed 12 slots keep every user value parameterized while allowing
    // PostgreSQL to retrieve every token match before the deterministic JS rank
    // and candidate cap. The NUL sentinel is not valid catalog text.
    const sql = this.sqlClient();
    const rows = await sql<ExerciseCatalogRow[]>`
      SELECT
        e.id,
        e.slug,
        COALESCE(localized.title, english.title, e.slug) AS title,
        COALESCE(localized.description, english.description) AS description,
        COALESCE(localized.instructions, english.instructions) AS instructions,
        COALESCE(localized.important_points, english.important_points) AS important_points,
        e.muscle_group,
        e.secondary_muscles,
        e.equipment,
        e.category,
        e.difficulty,
        e.exercise_type,
        e.has_video,
        e.has_video_white,
        e.has_video_gym,
        e.videos,
        e.video_url,
        e.video_hls_url,
        e.thumbnail_url,
        e.video_duration_secs
      FROM catalog_exercises e
      LEFT JOIN catalog_exercise_localizations localized
        ON localized.exercise_id = e.id AND localized.lang = ${lang}
      LEFT JOIN catalog_exercise_localizations english
        ON english.exercise_id = e.id AND english.lang = 'en'
      WHERE
        ${this.tokenPredicate(patterns[0])}
        OR ${this.tokenPredicate(patterns[1])}
        OR ${this.tokenPredicate(patterns[2])}
        OR ${this.tokenPredicate(patterns[3])}
        OR ${this.tokenPredicate(patterns[4])}
        OR ${this.tokenPredicate(patterns[5])}
        OR ${this.tokenPredicate(patterns[6])}
        OR ${this.tokenPredicate(patterns[7])}
        OR ${this.tokenPredicate(patterns[8])}
        OR ${this.tokenPredicate(patterns[9])}
        OR ${this.tokenPredicate(patterns[10])}
        OR ${this.tokenPredicate(patterns[11])}
    `;

    const candidates = rankAndCapCandidates(
      parsed,
      rows.map((row) => {
        const item = exerciseFromRow(row);
        return {
          id: item.id,
          slug: item.slug,
          title: item.title,
          description: item.description,
          muscleGroup: item.muscleGroup,
          equipment: item.equipment,
          canonicalEquipment: null,
          rank: [1, 1, 0, 1, 1, '', ''] as [number, number, number, number, number, string, string],
          item,
        };
      }).map(({ item, ...candidate }) => candidate),
      50,
    );
    const byId = new Map(rows.map((row) => [row.id, exerciseFromRow(row)]));
    const exercises = candidates
      .slice(0, Math.min(Math.max(input.pageSize, 1), 50))
      .map((candidate) => byId.get(candidate.id))
      .filter((item): item is ExerciseItem => Boolean(item));

    return {
      page: 1,
      pageSize: input.pageSize,
      total: exercises.length,
      exercises,
    };
  }

  private tokenPredicate(pattern: string) {
    return this.sqlClient()`
      lower(translate(
        concat_ws(' ', localized.title, english.title, e.slug, e.muscle_group, e.equipment),
        'áàãâäéèêëíìîïóòõôöúùûüçñÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇÑ',
        'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'
      ))
      ILIKE ${pattern} ESCAPE '\\'
    `;
  }

  private sqlClient(): postgres.Sql {
    if (!this.sql) throw new ExerciseSearchGatewayError('configuration', 'Exercise catalog database is not configured.');
    return this.sql;
  }

  async getById(input: ExerciseDetailInput): Promise<ExerciseItem | null> {
    if (!this.sql) {
      throw new ExerciseSearchGatewayError('configuration', 'Exercise catalog database is not configured.');
    }

    const lang = normalizeLang(input.lang);

    try {
      const rows = await this.sql<ExerciseCatalogRow[]>`
        SELECT
          e.id,
          e.slug,
          COALESCE(localized.title, english.title, e.slug) AS title,
          COALESCE(localized.description, english.description) AS description,
          COALESCE(localized.instructions, english.instructions) AS instructions,
          COALESCE(localized.important_points, english.important_points) AS important_points,
          e.muscle_group,
          e.secondary_muscles,
          e.equipment,
          e.category,
          e.difficulty,
          e.exercise_type,
          e.has_video,
          e.has_video_white,
          e.has_video_gym,
          e.videos,
          e.video_url,
          e.video_hls_url,
          e.thumbnail_url,
          e.video_duration_secs
        FROM catalog_exercises e
        LEFT JOIN catalog_exercise_localizations localized
          ON localized.exercise_id = e.id
          AND localized.lang = ${lang}
        LEFT JOIN catalog_exercise_localizations english
          ON english.exercise_id = e.id
          AND english.lang = 'en'
        WHERE e.id = ${input.id.trim()}
        LIMIT 1
      `;

      return rows[0] ? exerciseFromRow(rows[0]) : null;
    } catch (error) {
      throw new ExerciseSearchGatewayError(
        'upstream',
        error instanceof Error ? error.message : 'Exercise catalog detail lookup failed.'
      );
    }
  }
}
