import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { issue, report, startHub } from '@heimdall/hub/testing';

import { sendReport } from './delivery.ts';
import { invoke } from './testing/cli.ts';
import { tempStateDir } from './testing/fixtures.ts';

// A test Hub on a fresh database, served over HTTP on a free loopback port.
const servedHub = async () => {
  const h = await startHub();
  const server = Bun.serve({ fetch: h.hub.fetch, hostname: '127.0.0.1', port: 0 });
  return {
    ...h,
    url: `http://127.0.0.1:${String(server.port)}/`,
    [Symbol.asyncDispose]: async () => {
      await server.stop(true);
      await h[Symbol.asyncDispose]();
    },
  };
};

test('a System pairs with a real Hub, runs as the System it paired as, and its token authenticates Reports', async () => {
  await using h = await servedHub();
  await using dir = await tempStateDir();
  const code = await issue(h, 'desktop-1');
  // As an operator might type it: lower case, with the dash.
  const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();

  const paired = await invoke(['pair', typed, '--hub', h.url, '--state-dir', dir.path]);

  expect(paired.stdout).toStartWith('Paired as desktop-1.\n');
  expect(paired.code).toBe(0);
  const identity = JSON.parse(await readFile(join(dir.path, 'identity.json'), 'utf8')) as {
    hub: string;
    system: string;
    token: string;
  };
  expect(identity.system).toBe('desktop-1');
  expect(identity.hub).toBe(new URL(h.url).origin);

  const run = await invoke(['run', '--hub', h.url, '--state-dir', dir.path]);
  expect(run.stdout).toContain(`Sampling desktop-1 every 15 seconds for ${h.url}`);

  const delivery = await sendReport({
    hub: new URL(h.url),
    report: report(identity.system, [h.clock.now]),
    token: identity.token,
  });
  expect(delivery).toEqual({ kind: 'delivered' });
});

test('a spent code is refused by a real Hub and leaves the identity it paired as', async () => {
  await using h = await servedHub();
  await using dir = await tempStateDir();
  const code = await issue(h, 'desktop-1');
  await invoke(['pair', code, '--hub', h.url, '--state-dir', dir.path]);
  const before = await readFile(join(dir.path, 'identity.json'));

  const again = await invoke(['pair', code, '--hub', h.url, '--state-dir', dir.path]);

  expect(again.stderr).toContain('The Hub refused the code: it is invalid or expired.');
  expect(again.code).toBe(1);
  expect(await readFile(join(dir.path, 'identity.json'))).toEqual(before);
});
