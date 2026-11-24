import type { z } from 'zod';

// What is wrong with one setting, as one sentence naming its full key and never
// its value. A section that is not a table is `expected a table`; otherwise
// `expectation` words what a setting should hold, given the issue, and when it
// returns undefined the setting is just `invalid`.
export const describeIssue = (
  section: string,
  issue: z.core.$ZodIssue,
  expectation: (issue: z.core.$ZodIssue) => string | undefined,
): string => {
  const path = [section, ...issue.path.map(String)];
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => `${[...path, key].join('.')}: not a setting`).join('; ');
  }
  const detail = issue.path.length === 0 ? 'expected a table' : (expectation(issue) ?? 'invalid');
  return `${path.join('.')}: ${detail}`;
};
