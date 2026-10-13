import { describe, expect, test } from 'bun:test';

import {
  formatTokens,
  modelColor,
  modelFamily,
  modelName,
  stopLine,
  tokenLine,
} from './session-format.ts';

describe('modelName', () => {
  test('names a Claude model by family and version, dated or not', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(modelName('claude-opus-4-20250514')).toBe('Opus 4');
    expect(modelName('claude-fable-5-1')).toBe('Fable 5.1');
  });

  test('leaves any other model as the Harness recorded it', () => {
    expect(modelName('gpt-6.1-sol')).toBe('gpt-6.1-sol');
  });
});

describe('modelFamily', () => {
  test('is the family alone, or the whole name for any other model', () => {
    expect(modelFamily('claude-haiku-5-5')).toBe('Haiku');
    expect(modelFamily('gpt-6.1-sol')).toBe('gpt-6.1-sol');
  });
});

describe('modelColor', () => {
  test('gives each Claude family its own color, and every other model one more', () => {
    const colors = [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-1',
      'gpt-6.1-sol',
    ].map(modelColor);
    expect(new Set(colors).size).toBe(5);
    expect(modelColor('claude-opus-4-1')).toBe(modelColor('claude-opus-5-5'));
    expect(modelColor('o4-mini')).toBe(modelColor('gpt-6.1-sol'));
  });
});

describe('formatTokens', () => {
  test('reads as a count, thousands, or millions', () => {
    expect(formatTokens(512)).toBe('512');
    expect(formatTokens(1940)).toBe('1.9 k');
    expect(formatTokens(785_412)).toBe('785.4 k');
    expect(formatTokens(29_612_000)).toBe('29.6 M');
  });
});

describe('tokenLine', () => {
  test('sums up a request as input, output, and read from cache', () => {
    expect(tokenLine({ cacheReadTokens: 26_100, inputTokens: 2200, outputTokens: 1400 })).toBe(
      '2.2 k in, 1.4 k out, 26.1 k cached',
    );
  });
});

describe('stopLine', () => {
  test('says how the response ended', () => {
    expect(stopLine({ interrupted: false, stopReason: 'end_turn' })).toBe('It finished its turn.');
    expect(stopLine({ interrupted: false, stopReason: 'tool_use' })).toBe('It called tools.');
    expect(stopLine({ interrupted: true, stopReason: undefined })).toBe(
      'The person interrupted it.',
    );
    expect(stopLine({ interrupted: false, stopReason: 'max_tokens' })).toBe(
      'It stopped: max_tokens.',
    );
  });
});
