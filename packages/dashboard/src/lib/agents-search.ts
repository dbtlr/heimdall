import { AGENTS_BREAKDOWNS, AGENTS_RANGES } from '../server/agents-overview-types.ts';

const validZone = (zone: unknown): string | undefined => {
  if (
    typeof zone !== 'string' ||
    zone.length > 100 ||
    !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/u.test(zone)
  ) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

// A breakdown row's key: a project, System, model, or Harness name.
const validPick = (pick: unknown): string | undefined =>
  typeof pick === 'string' && pick.length > 0 && pick.length <= 512 ? pick : undefined;

export const agentsSearch = (search: Record<string, unknown>) => ({
  by: AGENTS_BREAKDOWNS.find((by) => by === search.by) ?? 'project',
  pick: validPick(search.pick),
  range: AGENTS_RANGES.find((range) => range === search.range) ?? 'today',
  zone: validZone(search.zone),
});

export const parseAgentsInput = (input: unknown) => {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('range' in input) ||
    !('timeZone' in input)
  ) {
    throw new Error('Invalid Agents period');
  }
  const range = AGENTS_RANGES.find((candidate) => candidate === input.range);
  const timeZone = validZone(input.timeZone);
  if (range === undefined || timeZone === undefined) {
    throw new Error('Invalid Agents period');
  }
  return { range, timeZone };
};
