import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tempStateDir } from '../testing/fixtures.ts';
import { checkFiles } from './files.ts';

const sha = (content: string) => new Bun.CryptoHasher('sha256').update(content).digest('hex');

test('one path in two records with different hashes is judged against each hash', async () => {
  await using dir = await tempStateDir();
  const path = join(dir.path, 'shared.conf');
  await writeFile(path, 'hello\n');

  const pass = await checkFiles({
    now: 10,
    previous: [],
    records: [
      { digest: 'da', files: [{ path, sha256: sha('hello\n') }], name: 'a-config' },
      { digest: 'db', files: [{ path, sha256: sha('goodbye\n') }], name: 'b-config' },
    ],
  });

  expect(pass?.mismatches).toEqual([{ path, record: 'b-config', since: 10, state: 'drifted' }]);
});

test('one path in two records with different hashes is judged against each hash, in either order', async () => {
  await using dir = await tempStateDir();
  const path = join(dir.path, 'shared.conf');
  await writeFile(path, 'hello\n');

  const pass = await checkFiles({
    now: 10,
    previous: [],
    records: [
      { digest: 'db', files: [{ path, sha256: sha('goodbye\n') }], name: 'b-config' },
      { digest: 'da', files: [{ path, sha256: sha('hello\n') }], name: 'a-config' },
    ],
  });

  expect(pass?.mismatches).toEqual([{ path, record: 'b-config', since: 10, state: 'drifted' }]);
});
