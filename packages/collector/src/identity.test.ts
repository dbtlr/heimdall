import { expect, test } from 'bun:test';
import { chmod, stat } from 'node:fs/promises';

import { readIdentity } from './identity.ts';
import { givenIdentity } from './testing/cli.ts';
import { tempStateDir } from './testing/fixtures.ts';

const owner = () => process.getuid?.() ?? 0;

// What `readIdentity` finds wrong with an identity it can read.
const exposuresOf = async (stateDir: string, uid = owner()) => {
  const read = await readIdentity(stateDir, { uid });
  if (read.kind !== 'paired') {
    throw new Error(`expected an identity, found ${read.kind}`);
  }
  return read.exposures;
};

test('an identity its owner alone can use, in a directory only its owner writes, is private', async () => {
  await using dir = await tempStateDir();
  await givenIdentity(dir.path);

  expect(await exposuresOf(dir.path)).toEqual([]);
});

test.each([
  ['group read', 0o640],
  ['other read', 0o604],
  ['group write', 0o620],
  ['other execute', 0o601],
])('an identity file with %s is exposed, with the mode and the fix', async (_, mode) => {
  await using dir = await tempStateDir();
  const path = await givenIdentity(dir.path, { mode });

  const exposures = await exposuresOf(dir.path);

  expect(exposures).toHaveLength(1);
  expect(exposures[0]).toContain(`${path} has mode 0${mode.toString(8)}`);
  expect(exposures[0]).toContain(`chmod 600 ${path}`);
});

test.each([
  ['group', 0o770],
  ['others', 0o703],
])(
  'a state directory %s can write to is exposed, since the identity could be replaced',
  async (_, mode) => {
    await using dir = await tempStateDir();
    await givenIdentity(dir.path);
    await chmod(dir.path, mode);

    const exposures = await exposuresOf(dir.path);

    expect(exposures).toHaveLength(1);
    expect(exposures[0]).toContain(`can write to ${dir.path}`);
    expect(exposures[0]).toContain(`chmod go-w ${dir.path}`);
  },
);

test('a state directory others can only read and enter is not exposed', async () => {
  await using dir = await tempStateDir();
  await givenIdentity(dir.path);
  await chmod(dir.path, 0o755);

  expect(await exposuresOf(dir.path)).toEqual([]);
});

test('an identity another user owns is exposed, naming both users', async () => {
  await using dir = await tempStateDir();
  const path = await givenIdentity(dir.path);
  const { uid } = await stat(path);

  const exposures = await exposuresOf(dir.path, uid + 1);

  expect(exposures).toEqual([
    `${path} is owned by uid ${String(uid)}, not this user (uid ${String(uid + 1)})`,
  ]);
});
