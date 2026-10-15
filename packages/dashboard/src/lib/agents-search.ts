import { AGENTS_RANGES } from '../server/agents-overview-types.ts';

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

export const agentsSearch = (search: Record<string, unknown>) => ({
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
