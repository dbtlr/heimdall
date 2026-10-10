import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { issue, report, startHub } from '@heimdall/hub/testing';
import { sample } from '@heimdall/schema/testing';

import { flushQueue, sendReport } from './delivery.ts';
import { openQueue } from './queue.ts';
import { reportIdentity } from './run.ts';
import { invoke } from './testing/cli.ts';
import { NO_SECTIONS, NO_TIME_ZONE, tempStateDir } from './testing/fixtures.ts';

// These tests need PostgreSQL, like the Hub's own: CI's gate provides it, while
// the release build's per-platform test step has none and skips them.
const withPostgres = test.skipIf(
  process.env.HEIMDALL_TEST_DATABASE_URL === undefined && Bun.which('initdb') === null,
);

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

withPostgres(
  'a System pairs with a real Hub, runs as the System it paired as, and its token authenticates Reports',
  async () => {
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
  },
);

withPostgres(
  'a spent code is refused by a real Hub and leaves the identity it paired as',
  async () => {
    await using h = await servedHub();
    await using dir = await tempStateDir();
    const code = await issue(h, 'desktop-1');
    await invoke(['pair', code, '--hub', h.url, '--state-dir', dir.path]);
    const before = await readFile(join(dir.path, 'identity.json'));

    const again = await invoke(['pair', code, '--hub', h.url, '--state-dir', dir.path]);

    expect(again.stderr).toContain('The Hub refused the code: it is invalid or expired.');
    expect(again.code).toBe(1);
    expect(await readFile(join(dir.path, 'identity.json'))).toEqual(before);
  },
);

// What a real Hub holds as sleeping for `system` after the Collector's identity,
// built with `sleeps`, delivers one queued sample.
const heldSleeps = async (sleeps: boolean | undefined) => {
  await using h = await servedHub();
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 10, stateDir: dir.path });
  queue.append(sample(h.clock.now));
  await flushQueue({
    identity: reportIdentity({ platform: 'linux', sleeps, system: 'laptop-1' }),
    now: () => h.clock.now,
    queue,
    sections: NO_SECTIONS,
    send: (body) => sendReport({ hub: new URL(h.url), report: body, token: 'laptop-token' }),
    timeZone: NO_TIME_ZONE,
    transcripts: () => ({ sources: [], spool: { bytes: 0, oldestAt: null } }),
  });
  queue.close();
  const [row]: { sleeps: boolean | null }[] = await h.db.sql`SELECT sleeps FROM systems`;
  return row?.sleeps;
};

withPostgres.each([
  { held: true, sleeps: true },
  { held: false, sleeps: false },
  { held: false, sleeps: undefined },
])(
  'a Report from a Collector set to sleeps $sleeps reaches the Hub as $held',
  async ({ held, sleeps }) => {
    expect(await heldSleeps(sleeps)).toBe(held);
  },
);
