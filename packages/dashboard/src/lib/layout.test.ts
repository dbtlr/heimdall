import { afterEach, expect, test } from 'bun:test';

import { isWideBrowser, WIDE_MEDIA } from './layout.ts';

const original = globalThis.matchMedia;

afterEach(() => {
  globalThis.matchMedia = original;
});

const stubMedia = (matches: boolean) => {
  const queries: string[] = [];
  globalThis.matchMedia = ((query: string) => {
    queries.push(query);
    return { matches };
  }) as typeof globalThis.matchMedia;
  return queries;
};

test('a wide browser matches the lg query', () => {
  const queries = stubMedia(true);
  expect(isWideBrowser()).toBe(true);
  expect(queries).toEqual([WIDE_MEDIA]);
});

test('a narrow browser does not', () => {
  stubMedia(false);
  expect(isWideBrowser()).toBe(false);
});

test('without matchMedia, as on the server, it is not wide', () => {
  // @ts-expect-error -- the server has no matchMedia.
  globalThis.matchMedia = undefined;
  expect(isWideBrowser()).toBe(false);
});
