import { expect, test } from 'bun:test';

import { parseProcessSubject, processSubject } from './process-observation.ts';

test('process subjects preserve separators and keep boot, pid, start and executable distinct', () => {
  const identity = { bootId: 'boot:one', name: 'a:b["c"]', pid: 42, start: '1234' };
  expect(parseProcessSubject(processSubject(identity))).toEqual(identity);
  expect(processSubject(identity)).not.toBe(processSubject({ ...identity, name: 'a:b' }));
  expect(processSubject(identity)).not.toBe(processSubject({ ...identity, start: '1235' }));
  for (const malformed of [
    'oops',
    '{}',
    '["b",-1,"3","bun"]',
    '["b",1,"bad","bun"]',
    '["b",1,"3","bun",0]',
  ]) {
    expect(parseProcessSubject(malformed)).toBeUndefined();
  }
});
