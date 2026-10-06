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
let stalled: Set<string>;
let server: ReturnType<typeof Bun.serve>;
let installDir: string;

beforeEach(async () => {
  release = new Map();
  stalled = new Set();
  server = Bun.serve({
    fetch: (request) => {
      const path = new URL(request.url).pathname.slice(1);
      if (stalled.has(path)) {
        // A download that starts and never finishes.
        return new Response(
          new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array(64)) }),
        );
      }
      const body = release.get(path);
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

// Publishes one binary on the fake release with its SHA256SUMS line, unless a
// test overrides the binary's content or the SHA256SUMS file.
const publish = (binary: string, sums?: string, content = fakeBinary(binary)) => {
  const asset = assetFor(binary);
  release.set(asset, content);
  release.set('SHA256SUMS', sums ?? `${sha256(content)}  ${asset}\n`);
};

const spawnInstall = (script: string, { detached = false } = {}) =>
  Bun.spawn(['sh', join(ROOT, script)], {
    detached,
    env: {
      HEIMDALL_INSTALL_DIR: installDir,
      HEIMDALL_RELEASE_URL: server.url.href.replace(/\/$/u, ''),
      HOME: installDir,
      PATH: process.env.PATH ?? '',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });

const install = async (script: string) => {
  const child = spawnInstall(script);
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

test('a binary that cannot run is refused and the installed one is kept', async () => {
  await writeFile(join(installDir, 'heimdall-collector'), 'old');
  publish('heimdall-collector', undefined, '#!/bin/sh\nexit 1\n');

  const { code, stderr } = await install(SCRIPTS.collector);

  expect(stderr).toContain('does not run on this System');
  expect(code).toBe(1);
  expect(await readFile(join(installDir, 'heimdall-collector'), 'utf8')).toBe('old');
  expect(await readdir(installDir)).toEqual(['heimdall-collector']);
});

// Linux refuses to write over an executable that is running, so only a rename
// can replace it; this is how Fleet updates a Collector that is collecting.
test.skipIf(process.platform !== 'linux')(
  'an install replaces a binary that is running',
  async () => {
    const installed = join(installDir, 'heimdall-collector');
    await writeFile(installed, await readFile('/bin/sleep'), { mode: 0o755 });
    const running = Bun.spawn([installed, '30']);
    try {
      publish('heimdall-collector');

      const { code } = await install(SCRIPTS.collector);

      expect(code).toBe(0);
      expect(await readFile(installed, 'utf8')).toBe(fakeBinary('heimdall-collector'));
    } finally {
      running.kill();
      await running.exited;
    }
  },
);

// The install directory's entry count once it reaches `count`, or after a few
// seconds, whichever comes first.
const entriesOnceAtLeast = async (count: number, deadline = Date.now() + 5000): Promise<number> => {
  const entries = (await readdir(installDir)).length;
  if (entries >= count || Date.now() >= deadline) {
    return entries;
  }
  await Bun.sleep(20);
  return entriesOnceAtLeast(count, deadline);
};

// systemd and an SSH hangup signal the whole process group, curl included.
test('an install stopped by SIGTERM leaves nothing behind', async () => {
  publish('heimdall-collector');
  stalled.add(assetFor('heimdall-collector'));
  const child = spawnInstall(SCRIPTS.collector, { detached: true });

  // Wait until the download has started writing next to the destination.
  expect(await entriesOnceAtLeast(2)).toBe(2);
  process.kill(-child.pid, 'SIGTERM');
  await child.exited;

  expect(await readdir(installDir)).toEqual([]);
});
