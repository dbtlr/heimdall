import { expect, test } from 'bun:test';

import { isCompiledModule } from './compiled.ts';

test('a module inside a binary from bun build --compile counts as compiled', () => {
  expect(isCompiledModule('file:///$bunfs/root/heimdall-hub')).toBe(true);
  expect(isCompiledModule('file:///B:/~BUN/root/heimdall-hub.exe')).toBe(true);
});

test('a module run from source does not', () => {
  expect(isCompiledModule('file:///home/operator/heimdall/packages/service/src/compiled.ts')).toBe(
    false,
  );
});

test('the tests themselves run from source', () => {
  expect(isCompiledModule(import.meta.url)).toBe(false);
});
