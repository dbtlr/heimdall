// How the Session page writes models, tokens, and the end of a response.

import type { SessionRequest } from '../server/session-view-types.ts';

// A Claude model id: family, major version, optional minor, optional date.
const CLAUDE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/u;

const claude = (model: string) => {
  const match = CLAUDE.exec(model);
  if (match === null) {
    return undefined;
  }
  const [, family = '', major = '', minor] = match;
  return {
    family: `${family.charAt(0).toUpperCase()}${family.slice(1)}`,
    version: minor === undefined ? major : `${major}.${minor}`,
  };
};

// "Opus 5.5" for claude-opus-5-5; any other model as recorded.
export const modelName = (model: string): string => {
  const found = claude(model);
  return found === undefined ? model : `${found.family} ${found.version}`;
};

// "Opus" for claude-opus-5-5; any other model as recorded.
export const modelFamily = (model: string): string => claude(model)?.family ?? model;

const FAMILY_COLORS: Record<string, string> = {
  Fable: '#b48cf2',
  Haiku: '#fab219',
  Opus: '#4a90ea',
  Sonnet: '#2bb39b',
};

// One color per Claude family, and the Codex Harness's color for any other model.
export const modelColor = (model: string): string =>
  FAMILY_COLORS[claude(model)?.family ?? ''] ?? '#e2672f';

// "512", "1.9 k", "29.6 M".
export const formatTokens = (tokens: number): string => {
  if (tokens < 1000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)} k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)} M`;
};

// "2.2 k in, 1.4 k out, 26.1 k cached".
export const tokenLine = (
  request: Pick<SessionRequest, 'cacheReadTokens' | 'inputTokens' | 'outputTokens'>,
): string =>
  `${formatTokens(request.inputTokens)} in, ${formatTokens(request.outputTokens)} out, ${formatTokens(request.cacheReadTokens)} cached`;

// How a response ended, as a sentence.
export const stopLine = (request: Pick<SessionRequest, 'interrupted' | 'stopReason'>): string => {
  if (request.interrupted) {
    return 'The person interrupted it.';
  }
  if (request.stopReason === 'end_turn') {
    return 'It finished its turn.';
  }
  if (request.stopReason === 'tool_use') {
    return 'It called tools.';
  }
  return `It stopped: ${request.stopReason ?? 'no reason recorded'}.`;
};
