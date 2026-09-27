/**
 * Conservative, deterministic interpretation of an exercise search query.
 *
 * The parser intentionally understands only movement/equipment vocabulary that
 * is versioned in this file. It never translates or rewrites the full query.
 */

export type EquipmentConstraint = {
  kind: 'include' | 'exclude';
  canonical: string;
};

export type ExerciseQuery = {
  original: string;
  normalized: string;
  tokens: string[];
  movementTokens: string[];
  equipmentTokens: string[];
  equipmentConstraint: EquipmentConstraint | null;
  unsupportedConstraint: boolean;
  contradictoryConstraint: boolean;
};

type Alias = {
  canonical: string;
  terms: string[];
};

const movementAliases: Alias[] = [
  { canonical: 'bench press', terms: ['supino', 'press de banca', 'bench press', 'bench'] },
  { canonical: 'push up', terms: ['flexao', 'flexão', 'flexiones', 'push up', 'push-up', 'pushup'] },
  { canonical: 'squat', terms: ['agachamento', 'sentadilla', 'squat'] },
  { canonical: 'pulldown', terms: ['puxada', 'jalon', 'jalón', 'pulldown'] },
  { canonical: 'row', terms: ['remada', 'remo', 'row'] },
];

const equipmentAliases: Alias[] = [
  { canonical: 'barbell', terms: ['barras', 'barra', 'barbell', 'barbells'] },
  { canonical: 'dumbbell', terms: ['halteres', 'halter', 'mancuernas', 'mancuerna', 'dumbbell', 'dumbbells'] },
  { canonical: 'cable', terms: ['polias', 'polia', 'cabos', 'cabo', 'cables', 'cable'] },
  { canonical: 'bodyweight', terms: ['peso corporal', 'peso do corpo', 'bodyweight', 'sem equipamento'] },
];

const unsupportedNegationMarkers = [
  'anything except',
  'except what',
  'menos o que',
  'exceto o que',
  'salvo lo que',
];

const negationPattern = /(?:^|\s)(?:sem|sin|without|no|nao|não|not)(?=\s|$)/u;

export function normalizeExerciseText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2010-\u2015-]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${normalizeExerciseText(phrase)} `);
}

function aliasMatches(text: string, aliases: Alias[]): Array<{ alias: Alias; term: string }> {
  const matches: Array<{ alias: Alias; term: string }> = [];
  for (const alias of aliases) {
    const ordered = [...alias.terms].sort((a, b) => normalizeExerciseText(b).length - normalizeExerciseText(a).length);
    const term = ordered.find((candidate) => containsPhrase(text, candidate));
    if (term) matches.push({ alias, term });
  }
  return matches;
}

function aliasOccurrences(text: string, aliases: Alias[]): Array<{ alias: Alias; term: string; index: number }> {
  const matches: Array<{ alias: Alias; term: string; index: number }> = [];
  for (const alias of aliases) {
    for (const candidate of alias.terms) {
      const normalizedTerm = normalizeExerciseText(candidate);
      const expression = new RegExp(`(?:^|\\s)${normalizedTerm.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?=$|\\s)`, 'gu');
      for (const match of text.matchAll(expression)) {
        matches.push({ alias, term: normalizedTerm, index: match.index ?? 0 });
      }
    }
  }
  return matches.sort((left, right) => left.index - right.index || right.term.length - left.term.length);
}

function hasNegationBefore(text: string, term: string, index: number): boolean {
  const normalizedTerm = normalizeExerciseText(term);
  if (!normalizedTerm || index < 0) return false;
  const prefix = text.slice(Math.max(0, index - 20), index);
  return /(?:^|\s)(?:sem|sin|without|no|nao|not)\s*$/u.test(prefix);
}

function hasUnsupportedNegation(
  text: string,
  equipmentMatches: Array<{ term: string; index: number }>,
): boolean {
  const negationExpression = new RegExp(negationPattern.source, 'gu');
  for (const match of text.matchAll(negationExpression)) {
    const index = match.index ?? 0;
    const coveredByAlias = equipmentMatches.some(
      ({ term, index: equipmentIndex }) =>
        index >= equipmentIndex && index < equipmentIndex + term.length,
    );
    const boundToEquipment = equipmentMatches.some(
      ({ term, index: equipmentIndex }) =>
        equipmentIndex >= index && equipmentIndex - index <= 20 && hasNegationBefore(text, term, equipmentIndex),
    );
    if (!coveredByAlias && !boundToEquipment) return true;
  }
  return false;
}

export function parseExerciseQuery(rawQuery: string): ExerciseQuery {
  const original = rawQuery.trim();
  const normalized = normalizeExerciseText(original).slice(0, 200);
  const tokens = normalized.split(' ').filter(Boolean).slice(0, 12);
  const movementMatches = aliasMatches(normalized, movementAliases);
  const equipmentMatches = aliasOccurrences(normalized, equipmentAliases);
  const equipmentTokens = [...new Set(equipmentMatches.map(({ alias }) => alias.canonical))];

  const includes = equipmentMatches.filter(({ term, index }) => !hasNegationBefore(normalized, term, index));
  const excludes = equipmentMatches.filter(({ term, index }) => hasNegationBefore(normalized, term, index));
  const unsupportedConstraint =
    unsupportedNegationMarkers.some((marker) => containsPhrase(normalized, marker)) ||
    hasUnsupportedNegation(normalized, equipmentMatches);
  const contradictoryConstraint = includes.some(({ alias }) => excludes.some(({ alias: excluded }) => excluded.canonical === alias.canonical));

  let equipmentConstraint: EquipmentConstraint | null = null;
  if (!unsupportedConstraint && !contradictoryConstraint && includes.length === 1 && excludes.length === 0) {
    equipmentConstraint = { kind: 'include', canonical: includes[0].alias.canonical };
  } else if (!unsupportedConstraint && !contradictoryConstraint && includes.length === 0 && excludes.length === 1) {
    equipmentConstraint = { kind: 'exclude', canonical: excludes[0].alias.canonical };
  }

  return {
    original,
    normalized,
    tokens,
    movementTokens: movementMatches.map(({ alias }) => alias.canonical),
    equipmentTokens,
    equipmentConstraint,
    unsupportedConstraint:
      unsupportedConstraint ||
      contradictoryConstraint ||
      includes.length > 1 ||
      excludes.length > 1 ||
      (includes.length > 0 && excludes.length > 0),
    contradictoryConstraint,
  };
}

export function normalizeEquipment(value: string): string | null {
  const normalized = normalizeExerciseText(value);
  const canonicals = new Set(aliasMatches(normalized, equipmentAliases).map(({ alias }) => alias.canonical));
  return canonicals.size === 1 ? [...canonicals][0] : null;
}

export function equipmentConstraintMatches(query: ExerciseQuery, equipment: string): boolean {
  if (!query.equipmentConstraint) return true;
  const normalized = normalizeEquipment(equipment);
  if (!normalized) return false;
  return query.equipmentConstraint.kind === 'include'
    ? normalized === query.equipmentConstraint.canonical
    : normalized !== query.equipmentConstraint.canonical;
}

export const EXERCISE_QUERY_ALIAS_VERSION = 'v1';
