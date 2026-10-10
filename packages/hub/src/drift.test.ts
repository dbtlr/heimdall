import { describe, expect, test } from 'bun:test';

import type { FilesRecord } from '@heimdall/schema';

import { evaluateDrift } from './drift.ts';
import { listSystems } from './store.ts';
import { page, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';

// Times are on 10 October 2026.
const at = (time: string) => Date.parse(`2026-10-10T${time}Z`);

const SHA = 'a'.repeat(64);

const CONF = '/etc/webapp/webapp.conf';
const ENV = '/etc/webapp/webapp.env';

const filesRecord = (name: string, ...paths: string[]): FilesRecord => ({
  files: paths.map((path) => ({ path, sha256: SHA })),
  name,
});

// A record set holding the given files records, as a Collector sends it.
const set = (...records: FilesRecord[]) => ({
  records: records.map((record) => ({ kind: 'files', name: record.name, record })),
  unreadable: [],
});

// A file the Collector found not to match, since 08:00.
const mismatch = (state: string, path = CONF, record = 'webapp-config') => ({
  path,
  record,
  since: at('08:00:00'),
  state,
});

// Sends laptop-1's Report at `time` on the Hub's clock with the given sections.
const send = async (h: Hub, time: string, sections: { checks?: unknown; records?: unknown }) => {
  h.clock.now = at(time);
  const response = await push(
    h.hub,
    {
      ...report('laptop-1', [at(time)]),
      sentAt: h.clock.now,
      ...(sections.records === undefined ? {} : { records: sections.records }),
      ...(sections.checks === undefined ? {} : { checks: sections.checks }),
    },
    { token: 'laptop-token' },
  );
  expect(response.status).toBe(200);
};

// Evaluates Drift at `time`, then answers laptop-1's open Conditions and Timeline.
const evaluate = async (h: Hub, time: string) => {
  h.clock.now = at(time);
  await evaluateDrift(h.db.sql, () => h.clock.now);
  const found = (await listSystems(h.db.sql)).find((s) => s.name === 'laptop-1');
  return { open: found?.conditions ?? [], timeline: found?.timeline ?? [] };
};

// Drift raised for the webapp config at 08:10 on 10 October, for the tests that
// start from an open Condition.
const driftedAndEvaluated = async (h: Hub) => {
  await send(h, '08:05:00', {
    checks: { files: [mismatch('drifted')] },
    records: set(filesRecord('webapp-config', CONF)),
  });
  await evaluate(h, '08:10:00');
};

describe('Drift', () => {
  test('is raised for a file whose content no longer matches, with the path as its subject', async () => {
    await using h = await startHub();
    await send(h, '08:05:00', {
      checks: { files: [mismatch('drifted')] },
      records: set(filesRecord('webapp-config', CONF)),
    });

    const { open } = await evaluate(h, '08:10:00');

    expect(open).toEqual([
      {
        kind: 'drift',
        raisedAt: at('08:10:00'),
        reason: 'Changed: its content no longer matches the hash recorded in webapp-config.',
        subject: CONF,
      },
    ]);
  });

  test('is raised for a recorded file that is missing, and says so', async () => {
    await using h = await startHub();
    await send(h, '08:05:00', {
      checks: { files: [mismatch('missing')] },
      records: set(filesRecord('webapp-config', CONF)),
    });

    const { open } = await evaluate(h, '08:10:00');

    expect(open).toMatchObject([
      { reason: 'Missing: the file recorded in webapp-config does not exist.', subject: CONF },
    ]);
  });

  test('is one Condition for each path, however many records name it', async () => {
    await using h = await startHub();
    await send(h, '08:05:00', {
      checks: {
        files: [
          mismatch('drifted', CONF, 'a-config'),
          mismatch('missing', CONF, 'b-config'),
          mismatch('drifted', ENV, 'a-config'),
        ],
      },
      records: set(filesRecord('a-config', CONF, ENV), filesRecord('b-config', CONF)),
    });

    const { open } = await evaluate(h, '08:10:00');

    expect(open.map((c) => c.subject)).toEqual([CONF, ENV]);
  });

  test('clears when the file matches again, and the Timeline keeps both', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { checks: { files: [] } });

    const { open, timeline } = await evaluate(h, '09:10:00');

    expect(open).toEqual([]);
    expect(timeline).toMatchObject([
      { at: at('09:10:00'), condition: 'drift', kind: 'cleared', subject: CONF },
      { at: at('08:10:00'), condition: 'drift', kind: 'raised', subject: CONF },
    ]);
  });

  test('takes the new reason when a changed file goes missing, without a new Condition', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { checks: { files: [mismatch('missing')] } });

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([
      { raisedAt: at('08:10:00'), reason: expect.stringContaining('Missing'), subject: CONF },
    ]);
  });

  test('is not raised for a file the Collector could not read, or a directory', async () => {
    await using h = await startHub();
    await send(h, '08:05:00', {
      checks: { files: [mismatch('unreadable', CONF), mismatch('unreadable', '/etc/webapp')] },
      records: set(filesRecord('webapp-config', CONF, '/etc/webapp')),
    });

    const { open, timeline } = await evaluate(h, '08:10:00');

    expect(open).toEqual([]);
    expect(timeline).toEqual([]);
  });

  test('stays as it is when its file becomes unreadable', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { checks: { files: [mismatch('unreadable')] } });

    const { open, timeline } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([{ raisedAt: at('08:10:00'), subject: CONF }]);
    expect(timeline).toHaveLength(1);
  });

  test('stays as it is while the checks are over budget, and while the System has sent none', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { checks: { overBudget: { bytes: 2_000_000 } } });
    const overBudget = await evaluate(h, '09:10:00');
    await using older = await startHub();
    await send(older, '08:05:00', { records: set(filesRecord('webapp-config', CONF)) });
    const noChecks = await evaluate(older, '08:10:00');

    expect(overBudget.open).toMatchObject([{ raisedAt: at('08:10:00'), subject: CONF }]);
    expect(overBudget.timeline).toHaveLength(1);
    expect(noChecks).toEqual({ open: [], timeline: [] });
  });

  test('stays as it is while the System has not sent its records, or sent them over budget', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { checks: { files: [] }, records: { overBudget: { bytes: 9e6 } } });

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([{ subject: CONF }]);
  });

  test('stays as it is when a Report carries no checks', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', {});

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([{ subject: CONF }]);
  });

  test('clears for a file whose record is forgotten, though the held checks still list it', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { records: set(filesRecord('other-config', ENV)) });

    const { open, timeline } = await evaluate(h, '09:10:00');

    expect(open).toEqual([]);
    expect(timeline).toMatchObject([{ condition: 'drift', kind: 'cleared', subject: CONF }, {}]);
  });

  test('is not raised for a file its record no longer names', async () => {
    await using h = await startHub();
    await send(h, '08:05:00', {
      checks: { files: [mismatch('drifted', ENV)] },
      records: set(filesRecord('webapp-config', CONF)),
    });

    const { open } = await evaluate(h, '08:10:00');

    expect(open).toEqual([]);
  });

  test('stays as it is for a record the Hub cannot read', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', {
      records: { records: [], unreadable: [{ kind: 'files', name: 'webapp-config' }] },
    });

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([{ subject: CONF }]);
  });

  test('ignores checks sent earlier than the ones the Hub holds', async () => {
    await using h = await startHub();
    await send(h, '08:05:00', {
      checks: { files: [mismatch('drifted')] },
      records: set(filesRecord('webapp-config', CONF)),
    });
    h.clock.now = at('08:06:00');
    const stale = await push(
      h.hub,
      { ...report('laptop-1', [at('08:06:00')]), checks: { files: [] }, sentAt: at('08:00:00') },
      { token: 'laptop-token' },
    );
    expect(stale.status).toBe(200);

    const { open } = await evaluate(h, '08:10:00');

    expect(open).toMatchObject([{ subject: CONF }]);
  });

  test('a System that cannot be judged does not stop the others, and the failure names it', async () => {
    await using h = await startHub();
    for (const system of ['laptop-1', 'server-1']) {
      h.clock.now = at('08:05:00');
      // oxlint-disable-next-line no-await-in-loop -- one System after the other.
      const response = await push(
        h.hub,
        {
          ...report(system, [at('08:05:00')]),
          checks: { files: [mismatch('drifted')] },
          records: set(filesRecord('webapp-config', CONF)),
          sentAt: h.clock.now,
        },
        { token: system === 'laptop-1' ? 'laptop-token' : 'server-token' },
      );
      expect(response.status).toBe(200);
    }
    // The database refuses laptop-1's Conditions.
    await h.db.sql.unsafe(`
      CREATE FUNCTION refuse_laptop() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused'; END $$;
      CREATE TRIGGER refuse_laptop BEFORE INSERT ON conditions
        FOR EACH ROW WHEN (NEW.system = 'laptop-1') EXECUTE FUNCTION refuse_laptop();
    `);
    h.clock.now = at('08:10:00');

    const failure = await evaluateDrift(h.db.sql, () => h.clock.now).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ message: expect.stringContaining('laptop-1: refused') });
    const server = (await listSystems(h.db.sql)).find((s) => s.name === 'server-1');
    expect(server?.conditions).toEqual([expect.objectContaining({ kind: 'drift', subject: CONF })]);
  });
});

test('the page names the file and the state in the Condition and the Timeline', async () => {
  await using h = await startHub();
  await driftedAndEvaluated(h);

  const html = await page(h.hub);

  expect(html).toContain(`<strong>Drift</strong> <code>${CONF}</code> since`);
  expect(html).toContain(`Drift <code>${CONF}</code>: <span class="reason">Changed:`);
});
