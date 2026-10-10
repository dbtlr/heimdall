import { expect, test } from 'bun:test';

import { combineParts } from './parts.ts';
import type { CheckParts } from './parts.ts';

// A source whose parts a test sets.
const source = (parts?: CheckParts) => {
  const held = { latest: parts };
  return { held, source: { latest: () => held.latest } };
};

test('has no parts until a source has some', () => {
  const files = source();
  const services = source();

  expect(combineParts([files.source, services.source]).latest()).toBeUndefined();
});

test('joins the parts of every source that has some', () => {
  const files = source({ fileRecords: [], files: [] });
  const services = source({ services: [] });

  expect(combineParts([files.source, services.source]).latest()).toEqual({
    fileRecords: [],
    files: [],
    services: [],
  });
});

test('carries the parts of one source while another has none yet', () => {
  const files = source();
  const services = source({ services: [] });

  expect(combineParts([files.source, services.source]).latest()).toEqual({ services: [] });
});

test('answers the same object until a source changes its parts', () => {
  const files = source({ files: [] });
  const services = source({ services: [] });
  const combined = combineParts([files.source, services.source]);
  const first = combined.latest();

  const unchanged = combined.latest();
  services.held.latest = { services: [] };
  const changed = combined.latest();

  expect(unchanged).toBe(first);
  expect(changed).not.toBe(first);
  expect(changed).toEqual(first);
});
