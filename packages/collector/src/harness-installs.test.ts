import { expect, test } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HarnessesSectionSchema, MAX_HARNESS_INSTALLS } from '@heimdall/schema';

import { fileReader, findHarnessInstalls } from './harness-installs.ts';
import type { DirEntry, InstallReader } from './harness-installs.ts';
import { tempStateDir } from './testing/fixtures.ts';

const HOME = '/home/operator';

type Node =
  | { kind: 'dir' }
  | { kind: 'file'; text: string }
  | { kind: 'link' }
  | { kind: 'denied' };

// Every directory above `path`.
const parentsOf = (path: string) => {
  const parts = path.split('/').slice(1);
  return parts.slice(0, -1).map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
};

// A mock directory tree: `dirs` and `links` are directory paths, `files` maps
// a path to its text. Parent directories exist implicitly. A path in `denied`
// can be neither listed nor read.
const tree = ({
  denied = [],
  dirs = [],
  files = {},
  links = [],
}: {
  denied?: string[];
  dirs?: string[];
  files?: Record<string, string>;
  links?: string[];
}): InstallReader => {
  const nodes = new Map<string, Node>();
  const add = (path: string, node: Node) => {
    for (const parent of parentsOf(path)) {
      if (!nodes.has(parent)) {
        nodes.set(parent, { kind: 'dir' });
      }
    }
    nodes.set(path, node);
  };
  for (const path of dirs) {
    add(path, { kind: 'dir' });
  }
  for (const [path, text] of Object.entries(files)) {
    add(path, { kind: 'file', text });
  }
  for (const path of links) {
    add(path, { kind: 'link' });
  }
  for (const path of denied) {
    add(path, { kind: 'denied' });
  }
  return {
    readDir: (path) => {
      const node = nodes.get(path);
      if (node?.kind === 'denied') {
        return Promise.reject(new Error('EACCES'));
      }
      if (node?.kind !== 'dir') {
        return Promise.resolve(undefined);
      }
      const entries: DirEntry[] = [];
      for (const [child, found] of nodes) {
        if (child.startsWith(`${path}/`) && !child.slice(path.length + 1).includes('/')) {
          entries.push({
            isDirectory: found.kind === 'dir',
            isSymlink: found.kind === 'link',
            name: child.slice(path.length + 1),
          });
        }
      }
      return Promise.resolve(entries);
    },
    readText: (path) => {
      const node = nodes.get(path);
      if (node?.kind === 'denied') {
        return Promise.reject(new Error('EACCES'));
      }
      return Promise.resolve(node?.kind === 'file' ? node.text : undefined);
    },
  };
};

const find = (
  reader: InstallReader,
  platform: 'darwin' | 'linux' = 'linux',
  env: Record<string, string | undefined> = {},
) => findHarnessInstalls({ env, home: HOME, platform, reader });

const MISE = `${HOME}/.local/share/mise/installs`;

test('a System with no Harness installed reports nothing', async () => {
  expect(
    await find(tree({ dirs: [`${HOME}/.config`, '/usr/lib/node_modules/typescript'] })),
  ).toEqual([]);
});

test('reads a version-named mise install directory, once per version, whatever aliases point at it', async () => {
  const reader = tree({
    dirs: [`${MISE}/claude/2.1.296`, `${MISE}/codex/0.162.1`],
    files: { [`${MISE}/claude/2.1.296/claude`]: '' },
    links: [
      `${MISE}/claude/2`,
      `${MISE}/claude/2.1`,
      `${MISE}/claude/latest`,
      `${MISE}/codex/0`,
      `${MISE}/codex/latest`,
    ],
  });

  expect(await find(reader)).toEqual([
    { harness: 'claude-code', location: 'mise', version: '2.1.296' },
    { harness: 'codex', location: 'mise', version: '0.162.1' },
  ]);
});

test('reads every version a mise tool holds, and the npm backed tool name', async () => {
  const reader = tree({
    dirs: [
      `${MISE}/claude/2.1.296`,
      `${MISE}/claude/2.0.5`,
      `${MISE}/npm-openai-codex/0.160.0`,
      `${MISE}/node/22.1.0`,
    ],
  });

  expect(await find(reader)).toEqual([
    { harness: 'claude-code', location: 'mise', version: '2.0.5' },
    { harness: 'claude-code', location: 'mise', version: '2.1.296' },
    { harness: 'codex', location: 'mise', version: '0.160.0' },
  ]);
});

test.each(['linux', 'darwin'] as const)(
  "reads the native installer's version files on %s",
  async (platform) => {
    const dir = `${HOME}/.local/share/claude/versions`;
    const reader = tree({
      files: { [`${dir}/2.1.290`]: '', [`${dir}/2.1.296`]: '', [`${dir}/.lock`]: '' },
      links: [`${dir}/current`],
    });

    expect(await find(reader, platform)).toEqual([
      { harness: 'claude-code', location: 'native', version: '2.1.290' },
      { harness: 'claude-code', location: 'native', version: '2.1.296' },
    ]);
  },
);

test.each([
  ['linux', '/usr/lib/node_modules', 'claude-code', '@anthropic-ai/claude-code', '2.1.1'],
  ['linux', '/usr/local/lib/node_modules', 'codex', '@openai/codex', '0.5.0'],
  ['darwin', '/opt/homebrew/lib/node_modules', 'codex', '@openai/codex', '0.6.0'],
  ['darwin', '/usr/local/lib/node_modules', 'claude-code', '@anthropic-ai/claude-code', '2.2.0'],
  ['linux', `${HOME}/.npm-global/lib/node_modules`, 'codex', '@openai/codex', '0.7.0'],
  [
    'darwin',
    `${HOME}/.bun/install/global/node_modules`,
    'claude-code',
    '@anthropic-ai/claude-code',
    '2.3.0',
  ],
  [
    'linux',
    `${HOME}/.claude/local/node_modules`,
    'claude-code',
    '@anthropic-ai/claude-code',
    '1.0.9',
  ],
] as const)(
  'reads the version in %s package.json under %s',
  async (platform, root, harness, pkg, version) => {
    const reader = tree({
      files: { [`${root}/${pkg}/package.json`]: JSON.stringify({ version }) },
    });

    expect(await find(reader, platform)).toEqual([{ harness, location: 'npm', version }]);
  },
);

test("does not look in another platform's global npm directory", async () => {
  const pkg = '/opt/homebrew/lib/node_modules/@openai/codex/package.json';

  expect(await find(tree({ files: { [pkg]: '{"version":"0.6.0"}' } }), 'linux')).toEqual([]);
});

test.each([
  ['linux', '/home/linuxbrew/.linuxbrew', 'Cellar'],
  ['linux', `${HOME}/.linuxbrew`, 'Cellar'],
  ['darwin', '/opt/homebrew', 'Cellar'],
  ['darwin', '/usr/local', 'Cellar'],
  ['darwin', '/opt/homebrew', 'Caskroom'],
  ['darwin', '/usr/local', 'Caskroom'],
] as const)(
  'reads a Homebrew version directory on %s under %s/%s',
  async (platform, prefix, kind) => {
    const reader = tree({
      dirs: [`${prefix}/${kind}/codex/0.161.0`, `${prefix}/${kind}/wget/1.2.3`],
    });

    expect(await find(reader, platform)).toEqual([
      { harness: 'codex', location: 'homebrew', version: '0.161.0' },
    ]);
  },
);

test('reports an install in each place it is found, in a stable order', async () => {
  const reader = tree({
    dirs: [`${MISE}/claude/2.1.296`, '/opt/homebrew/Caskroom/claude-code/2.1.200'],
    files: {
      '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/package.json':
        '{"version":"2.0.0"}',
    },
  });

  expect(await find(reader, 'darwin')).toEqual([
    { harness: 'claude-code', location: 'homebrew', version: '2.1.200' },
    { harness: 'claude-code', location: 'mise', version: '2.1.296' },
    { harness: 'claude-code', location: 'npm', version: '2.0.0' },
  ]);
});

test('the same install found twice is reported once', async () => {
  const reader = tree({
    files: {
      '/usr/lib/node_modules/@openai/codex/package.json': '{"version":"0.5.0"}',
      '/usr/local/lib/node_modules/@openai/codex/package.json': '{"version":"0.5.0"}',
    },
  });

  expect(await find(reader)).toEqual([{ harness: 'codex', location: 'npm', version: '0.5.0' }]);
});

test.each([
  ['a package.json that is missing', {}],
  ['a package.json that is not JSON', { 'package.json': 'not json' }],
  ['a package.json without a version', { 'package.json': '{"name":"@openai/codex"}' }],
  ['a package.json whose version is not a string', { 'package.json': '{"version":5}' }],
  ['a package.json whose version is not a version', { 'package.json': '{"version":"latest!"}' }],
])('an npm install with %s reports unknown', async (_, files) => {
  const pkg = '/usr/lib/node_modules/@openai/codex';
  const reader = tree({
    dirs: [pkg],
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [`${pkg}/${name}`, text]),
    ),
  });

  expect(await find(reader)).toEqual([{ harness: 'codex', location: 'npm', version: 'unknown' }]);
});

test('an npm install whose package.json cannot be read reports unknown', async () => {
  const pkg = '/usr/lib/node_modules/@openai/codex';

  expect(await find(tree({ denied: [`${pkg}/package.json`], dirs: [pkg] }))).toEqual([
    { harness: 'codex', location: 'npm', version: 'unknown' },
  ]);
});

test('an npm install directory that cannot be listed reports unknown', async () => {
  expect(await find(tree({ denied: ['/usr/lib/node_modules/@openai/codex'] }))).toEqual([
    { harness: 'codex', location: 'npm', version: 'unknown' },
  ]);
});

test('a directory that cannot be listed costs only what is under it, and the install is unknown', async () => {
  const reader = tree({
    denied: [`${MISE}/claude`],
    dirs: [`${MISE}/codex/0.162.1`],
  });

  expect(await find(reader)).toEqual([
    { harness: 'claude-code', location: 'mise', version: 'unknown' },
    { harness: 'codex', location: 'mise', version: '0.162.1' },
  ]);
});

test.each([
  ['a Homebrew Cellar', '/home/linuxbrew/.linuxbrew/Cellar/codex', 'homebrew'],
  ['a Homebrew Caskroom', '/opt/homebrew/Caskroom/codex', 'homebrew'],
  ['the native installer directory', `${HOME}/.local/share/claude/versions`, 'native'],
] as const)('%s that cannot be listed reports unknown', async (_, denied, location) => {
  const platform = denied.startsWith('/opt') ? 'darwin' : 'linux';
  const harness = location === 'native' ? 'claude-code' : 'codex';

  expect(await find(tree({ denied: [denied] }), platform)).toEqual([
    { harness, location, version: 'unknown' },
  ]);
});

test('a Homebrew HEAD keg and a mise ref install are installs whose version is unknown', async () => {
  const reader = tree({
    dirs: [`${MISE}/claude/ref-main`, '/home/linuxbrew/.linuxbrew/Cellar/codex/HEAD-1a2b3c4'],
  });

  expect(await find(reader)).toEqual([
    { harness: 'claude-code', location: 'mise', version: 'unknown' },
    { harness: 'codex', location: 'homebrew', version: 'unknown' },
  ]);
});

test('an empty tool directory is not an install', async () => {
  expect(await find(tree({ dirs: [`${MISE}/claude`] }))).toEqual([]);
});

test('a symlink named for a full version is that install, and aliases are not', async () => {
  const reader = tree({
    dirs: [`${MISE}/claude/2.0.0`],
    links: [`${MISE}/claude/2.1.296`, `${MISE}/claude/latest`, `${MISE}/claude/2.1`],
  });

  expect(await find(reader)).toEqual([
    { harness: 'claude-code', location: 'mise', version: '2.0.0' },
    { harness: 'claude-code', location: 'mise', version: '2.1.296' },
  ]);
});

test('a plain file named for a version is not a mise or Homebrew install', async () => {
  const reader = tree({
    files: {
      [`${MISE}/claude/2.1.296`]: '',
      '/home/linuxbrew/.linuxbrew/Cellar/codex/0.5.0': '',
    },
  });

  expect(await find(reader)).toEqual([]);
});

test('versions sort by number, not by text', async () => {
  const reader = tree({
    dirs: [`${MISE}/claude/2.10.0`, `${MISE}/claude/2.9.0`, `${MISE}/claude/2.100.0`],
  });

  expect((await find(reader)).map((i) => i.version)).toEqual(['2.9.0', '2.10.0', '2.100.0']);
});

test('versions that compare equal by number keep one order whatever order they are listed in', async () => {
  const forward = tree({ dirs: [`${MISE}/claude/1.1.0`, `${MISE}/claude/1.01.0`] });
  const backward = tree({ dirs: [`${MISE}/claude/1.01.0`, `${MISE}/claude/1.1.0`] });

  expect(await find(forward)).toEqual(await find(backward));
});

test('claude-code local installer packages are not looked for as Codex', async () => {
  const reader = tree({
    files: {
      [`${HOME}/.claude/local/node_modules/@openai/codex/package.json`]: '{"version":"0.5.0"}',
    },
  });

  expect(await find(reader)).toEqual([]);
});

test('MISE_DATA_DIR and XDG_DATA_HOME move the mise and native roots', async () => {
  const reader = tree({
    dirs: ['/data/mise/installs/claude/2.1.296', '/xdg/mise/installs/codex/0.5.0'],
    files: { '/xdg/claude/versions/2.1.290': '' },
  });

  expect(await find(reader, 'linux', { MISE_DATA_DIR: '/data/mise' })).toEqual([
    { harness: 'claude-code', location: 'mise', version: '2.1.296' },
  ]);
  expect(await find(reader, 'linux', { XDG_DATA_HOME: '/xdg' })).toEqual([
    { harness: 'claude-code', location: 'native', version: '2.1.290' },
    { harness: 'codex', location: 'mise', version: '0.5.0' },
  ]);
});

test('a data directory that is not absolute is ignored', async () => {
  const reader = tree({ dirs: [`${MISE}/claude/2.1.296`] });

  expect(await find(reader, 'linux', { MISE_DATA_DIR: 'relative', XDG_DATA_HOME: '' })).toEqual([
    { harness: 'claude-code', location: 'mise', version: '2.1.296' },
  ]);
});

test('many versions of one Harness never crowd out another', async () => {
  const dirs = [
    ...Array.from(
      { length: MAX_HARNESS_INSTALLS + 10 },
      (_, i) => `${MISE}/claude/1.0.${String(i)}`,
    ),
    `${MISE}/codex/0.5.0`,
  ];

  const found = await find(tree({ dirs }));

  expect(found.filter((i) => i.harness === 'codex')).toHaveLength(1);
  expect(found.length).toBeLessThanOrEqual(MAX_HARNESS_INSTALLS);
});

test('a version too long for the section is not reported as one, so the section stays valid', async () => {
  const long = `1.2.${'9'.repeat(70)}`;
  const pkg = '/usr/lib/node_modules/@openai/codex';
  const reader = tree({
    dirs: [`${MISE}/claude/${long}`],
    files: { [`${pkg}/package.json`]: JSON.stringify({ version: long }) },
  });

  const installs = await find(reader);

  expect(installs).toEqual([{ harness: 'codex', location: 'npm', version: 'unknown' }]);
  expect(HarnessesSectionSchema.safeParse({ installs }).success).toBe(true);
});

test('a package.json that is a FIFO does not hang the scan', async () => {
  await using dir = await tempStateDir();
  const pkg = join(dir.path, '.npm-global/lib/node_modules/@openai/codex');
  await mkdir(pkg, { recursive: true });
  expect(await Bun.spawn(['mkfifo', join(pkg, 'package.json')]).exited).toBe(0);

  const installs = await findHarnessInstalls({
    env: {},
    home: dir.path,
    platform: 'linux',
    reader: fileReader,
  });

  expect(installs).toEqual([{ harness: 'codex', location: 'npm', version: 'unknown' }]);
});

test('a package.json past the size cap reports unknown', async () => {
  await using dir = await tempStateDir();
  const pkg = join(dir.path, '.npm-global/lib/node_modules/@openai/codex');
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ description: 'x'.repeat(100_000), version: '0.5.0' }),
  );

  const installs = await findHarnessInstalls({
    env: {},
    home: dir.path,
    platform: 'linux',
    reader: fileReader,
  });

  expect(installs).toEqual([{ harness: 'codex', location: 'npm', version: 'unknown' }]);
});

test('a directory in a version place whose name is not a version is not an install', async () => {
  const reader = tree({ dirs: [`${MISE}/claude/backup`, `${MISE}/claude/2.1.296.old dir`] });

  expect(await find(reader)).toEqual([]);
});

test('keeps no more installs of a Harness than its share of the section', async () => {
  const dirs = Array.from(
    { length: MAX_HARNESS_INSTALLS + 10 },
    (_, i) => `${MISE}/claude/1.0.${String(i)}`,
  );

  expect(await find(tree({ dirs }))).toHaveLength(MAX_HARNESS_INSTALLS / 2);
});

test('finding installs takes only a filesystem reader, so no Harness binary can run', async () => {
  const source = await readFile(join(import.meta.dir, 'harness-installs.ts'), 'utf8');

  expect(findHarnessInstalls.length).toBe(1);
  expect(source).not.toMatch(/child_process|Bun\.spawn|Bun\.\$|subprocess|execFile/u);
});

test('the file reader lists a directory, reads text, and answers undefined for what is absent', async () => {
  await using dir = await tempStateDir();
  await mkdir(join(dir.path, 'versions'));
  await writeFile(join(dir.path, 'versions', '2.1.296'), 'binary');
  await symlink('2.1.296', join(dir.path, 'versions', 'current'));
  await mkdir(join(dir.path, 'versions', '2.0.0'));

  const entries = await fileReader.readDir(join(dir.path, 'versions'));

  expect(entries?.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
    { isDirectory: true, isSymlink: false, name: '2.0.0' },
    { isDirectory: false, isSymlink: false, name: '2.1.296' },
    { isDirectory: false, isSymlink: true, name: 'current' },
  ]);
  expect(await fileReader.readText(join(dir.path, 'versions', '2.1.296'))).toBe('binary');
  expect(await fileReader.readDir(join(dir.path, 'absent'))).toBeUndefined();
  expect(await fileReader.readText(join(dir.path, 'absent'))).toBeUndefined();
});
