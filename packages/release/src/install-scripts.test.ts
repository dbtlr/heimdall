import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');
const SCRIPTS = { collector: 'install-collector.sh', hub: 'install-hub.sh' } as const;

const assetFor = (binary: string) =>
  `${binary}-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

// A stand-in binary: a script that prints a version line, as the real one does.
const fakeBinary = (binary: string) => `#!/bin/sh\necho "${binary} v9.9.9 (Report schema v1)"\n`;

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

let release: Map<string, string>;
let server: ReturnType<typeof Bun.serve>;
let installDir: string;

beforeEach(async () => {
  release = new Map();
  server = Bun.serve({
    fetch: (request) => {
      const body = release.get(new URL(request.url).pathname.slice(1));
      return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  installDir = await mkdtemp(join(tmpdir(), 'heimdall-install-'));
});

afterEach(async () => {
  await server.stop(true);
  await rm(installDir, { force: true, recursive: true });
});

// Publishes one binary on the fake release, with SHA256SUMS lines for the
// given assets and contents (the real ones unless a test overrides them).
const publish = (binary: string, sums?: string) => {
  const asset = assetFor(binary);
  const content = fakeBinary(binary);
  release.set(asset, content);
  release.set('SHA256SUMS', sums ?? `${sha256(content)}  ${asset}\n`);
};

const install = async (script: string) => {
  const child = Bun.spawn(['sh', join(ROOT, script)], {
    env: {
      HEIMDALL_INSTALL_DIR: installDir,
      HEIMDALL_RELEASE_URL: server.url.href.replace(/\/$/u, ''),
      HOME: installDir,
      PATH: process.env.PATH ?? '',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
};

// Normalizes the one thing the scripts may differ in: which binary they name.
const normalized = async (script: string) =>
  (await readFile(join(ROOT, script), 'utf8')).replaceAll(
    /heimdall-(?:collector|hub)|install-(?:collector|hub)\.sh|Collector|Hub/gu,
    'X',
  );

test('the Collector and Hub install scripts differ only in the binary they name', async () => {
  expect(await normalized(SCRIPTS.hub)).toBe(await normalized(SCRIPTS.collector));
});

test.each(Object.entries(SCRIPTS))(
  'the %s script installs the verified binary for this platform',
  async (pkg, script) => {
    const binary = `heimdall-${pkg}`;
    publish(binary);

    const { code, stderr } = await install(script);

    expect(stderr).toContain(`Installed ${binary} v9.9.9 (Report schema v1)`);
    expect(code).toBe(0);
    expect(await readFile(join(installDir, binary), 'utf8')).toBe(fakeBinary(binary));
    expect(await readdir(installDir)).toEqual([binary]);
  },
);

test('an install replaces the binary already there', async () => {
  await writeFile(join(installDir, 'heimdall-collector'), 'old');
  publish('heimdall-collector');

  const { code } = await install(SCRIPTS.collector);

  expect(code).toBe(0);
  expect(await readFile(join(installDir, 'heimdall-collector'), 'utf8')).toBe(
    fakeBinary('heimdall-collector'),
  );
});

test('a binary that fails its checksum is refused and nothing is installed', async () => {
  const asset = assetFor('heimdall-collector');
  publish('heimdall-collector', `${sha256('something else')}  ${asset}\n`);

  const { code, stderr } = await install(SCRIPTS.collector);

  expect(stderr).toContain(`checksum mismatch for ${asset}`);
  expect(code).toBe(1);
  expect(await readdir(installDir)).toEqual([]);
});

test('a binary SHA256SUMS does not list is refused', async () => {
  publish('heimdall-collector', `${sha256('x')}  heimdall-collector-plan9-mips\n`);

  const { code, stderr } = await install(SCRIPTS.collector);

  expect(stderr).toContain(`SHA256SUMS lists no ${assetFor('heimdall-collector')}`);
  expect(code).toBe(1);
  expect(await readdir(installDir)).toEqual([]);
});

test('a release without SHA256SUMS is refused', async () => {
  publish('heimdall-collector');
  release.delete('SHA256SUMS');

  const { code, stderr } = await install(SCRIPTS.collector);

  expect(stderr).toContain('download failed');
  expect(stderr).toContain('SHA256SUMS');
  expect(code).toBe(1);
  expect(await readdir(installDir)).toEqual([]);
});
