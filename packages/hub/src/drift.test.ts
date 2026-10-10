import { describe, expect, test } from 'bun:test';

import { filesRecordDigest } from '@heimdall/schema';
import type { FilesRecord } from '@heimdall/schema';

import { evaluateDrift } from './drift.ts';
import { unpair } from './pairing.ts';
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

// A checks section for a pass that hashed `records` as they are and found
// `files` not to match.
const checks = async (records: FilesRecord[], ...files: object[]) => ({
  fileRecords: await Promise.all(
    records.map(async (record) => ({
      digest: await filesRecordDigest(record),
      record: record.name,
    })),
  ),
  files,
});

const WEBAPP = filesRecord('webapp-config', CONF);

// Sends laptop-1's Report at `time` on the Hub's clock with the given sections.
const send = async (
  h: Hub,
  time: string,
  sections: { checks?: unknown; records?: unknown; sentAt?: number },
) => {
  h.clock.now = at(time);
  const response = await push(
    h.hub,
    {
      ...report('laptop-1', [at(time)]),
      sentAt: sections.sentAt ?? h.clock.now,
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
    checks: await checks([WEBAPP], mismatch('drifted')),
    records: set(WEBAPP),
  });
  await evaluate(h, '08:10:00');
};

const subjects = (open: { subject: string }[]) => open.map((c) => c.subject);

describe('Drift', () => {
  test('stays open on an unpaired System and shows in the unpaired view', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);

    await unpair(h.db.sql, 'laptop-1');
    const { open } = await evaluate(h, '09:10:00');

    expect(subjects(open)).toEqual([CONF]);
    expect(await page(h.hub)).not.toContain('laptop-1');
    const html = await page(h.hub, '/?unpaired');
    expect(html).toContain('<strong>Unpaired</strong>');
    expect(html).toContain('<strong>Drift</strong>');
  });

  test('is raised for a file whose content no longer matches, with the path as its subject', async () => {
    await using h = await startHub();
    await send(h, '08:05:00', {
      checks: await checks([WEBAPP], mismatch('drifted')),
      records: set(WEBAPP),
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
      checks: await checks([WEBAPP], mismatch('missing')),
      records: set(WEBAPP),
    });

    const { open } = await evaluate(h, '08:10:00');

    expect(open).toMatchObject([
      { reason: 'Missing: the file recorded in webapp-config does not exist.', subject: CONF },
    ]);
  });

  test('is one Condition for each path, however many records name it', async () => {
    await using h = await startHub();
    const a = filesRecord('a-config', CONF, ENV);
    const b = filesRecord('b-config', CONF);
    await send(h, '08:05:00', {
      checks: await checks(
        [a, b],
        mismatch('drifted', CONF, 'a-config'),
        mismatch('missing', CONF, 'b-config'),
        mismatch('drifted', ENV, 'a-config'),
      ),
      records: set(a, b),
    });

    const { open } = await evaluate(h, '08:10:00');

    expect(subjects(open)).toEqual([CONF, ENV]);
  });

  test('names, in its reason, the first record by name that shows the path changed', async () => {
    await using h = await startHub();
    const a = filesRecord('a-config', CONF);
    const b = filesRecord('B-config', CONF);
    await send(h, '08:05:00', {
      checks: await checks(
        [b, a],
        mismatch('drifted', CONF, 'a-config'),
        mismatch('drifted', CONF, 'B-config'),
      ),
      records: set(a, b),
    });

    const { open } = await evaluate(h, '08:10:00');

    // Uppercase sorts before lowercase by code unit, in every locale.
    expect(open).toMatchObject([{ reason: expect.stringContaining('B-config') }]);
  });

  test('clears when the file matches again, and the Timeline keeps both', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { checks: await checks([WEBAPP]) });

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
    await send(h, '09:05:00', { checks: await checks([WEBAPP], mismatch('missing')) });

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([
      { raisedAt: at('08:10:00'), reason: expect.stringContaining('Missing'), subject: CONF },
    ]);
  });

  test('is not raised for a file the Collector could not read, or a directory', async () => {
    await using h = await startHub();
    const app = filesRecord('webapp-config', CONF, '/etc/webapp');
    await send(h, '08:05:00', {
      checks: await checks(
        [app],
        mismatch('unreadable', CONF),
        mismatch('unreadable', '/etc/webapp'),
      ),
      records: set(app),
    });

    const { open, timeline } = await evaluate(h, '08:10:00');

    expect(open).toEqual([]);
    expect(timeline).toEqual([]);
  });

  test('stays as it is when its file becomes unreadable', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { checks: await checks([WEBAPP], mismatch('unreadable')) });

    const { open, timeline } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([{ raisedAt: at('08:10:00'), subject: CONF }]);
    expect(timeline).toHaveLength(1);
  });

  test('is raised for a path while any record shows it changed, though another cannot read it', async () => {
    await using h = await startHub();
    const a = filesRecord('a-config', CONF);
    const b = filesRecord('b-config', CONF);
    await send(h, '08:05:00', {
      checks: await checks(
        [a, b],
        mismatch('unreadable', CONF, 'a-config'),
        mismatch('drifted', CONF, 'b-config'),
      ),
      records: set(a, b),
    });
    await using other = await startHub();
    await send(other, '08:05:00', {
      checks: await checks(
        [a, b],
        mismatch('drifted', CONF, 'a-config'),
        mismatch('unreadable', CONF, 'b-config'),
      ),
      records: set(a, b),
    });

    const first = await evaluate(h, '08:10:00');
    const second = await evaluate(other, '08:10:00');

    expect(subjects(first.open)).toEqual([CONF]);
    expect(subjects(second.open)).toEqual([CONF]);
  });

  test('stays as it is while the files part is over budget, and while the System has sent none', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { checks: { overBudget: { files: { bytes: 2_000_000 } } } });
    const overBudget = await evaluate(h, '09:10:00');
    await using none = await startHub();
    await send(none, '08:05:00', { records: set(WEBAPP) });
    const noChecks = await evaluate(none, '08:10:00');

    expect(overBudget.open).toMatchObject([{ raisedAt: at('08:10:00'), subject: CONF }]);
    expect(overBudget.timeline).toHaveLength(1);
    expect(noChecks).toEqual({ open: [], timeline: [] });
  });

  test('clears for a forgotten record while the files part is over budget, since no record names the path', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', {
      checks: { overBudget: { files: { bytes: 2_000_000 } } },
      records: set(filesRecord('other-config', ENV)),
    });

    const { open, timeline } = await evaluate(h, '09:10:00');

    expect(open).toEqual([]);
    expect(timeline).toMatchObject([{ condition: 'drift', kind: 'cleared', subject: CONF }, {}]);
  });

  test('stays as it is while the files part is over budget and a record the Hub cannot read might name the path', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', {
      checks: { overBudget: { files: { bytes: 2_000_000 } } },
      records: { records: [], unreadable: [{ kind: 'files', name: 'webapp-config' }] },
    });

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([{ subject: CONF }]);
  });

  test('judges nothing, and does not fail, for a System that sent checks but never records', async () => {
    await using h = await startHub();
    await send(h, '08:05:00', { checks: await checks([WEBAPP], mismatch('drifted')) });

    const { open } = await evaluate(h, '08:10:00');

    expect(open).toEqual([]);
  });

  test('stays as it is while the System sent its records over budget', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', {
      checks: await checks([WEBAPP]),
      records: { overBudget: { bytes: 9e6 } },
    });

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

  test('stays as it is when a section carries no files part, as one from a newer Collector might', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { checks: {} });

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([{ subject: CONF }]);
  });

  test('stays as it is when a section lists a hashed record but carries no files part', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { checks: { fileRecords: (await checks([WEBAPP])).fileRecords } });

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([{ raisedAt: at('08:10:00'), subject: CONF }]);
  });

  test('clears for a file whose record is forgotten while the section carries no files part, which judges no record', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { checks: {}, records: set(filesRecord('other-config', ENV)) });

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toEqual([]);
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
      checks: await checks([WEBAPP], mismatch('drifted', ENV)),
      records: set(WEBAPP),
    });

    const { open } = await evaluate(h, '08:10:00');

    expect(open).toEqual([]);
  });
});

describe('Drift while the checks and the records describe different versions', () => {
  describe('beside another record that is unreadable', () => {
    const a = filesRecord('a-config', CONF);
    const b = filesRecord('b-config', CONF);

    // b-config shows CONF drifted, so Drift is open; then b-config turns
    // unreadable and a-config, judged, shows CONF matching.
    const driftedByB = async (h: Hub) => {
      await send(h, '08:05:00', {
        checks: await checks([a, b], mismatch('drifted', CONF, 'b-config')),
        records: set(a, b),
      });
      await evaluate(h, '08:10:00');
    };

    test('stays as it is when the Collector can no longer read the record', async () => {
      await using h = await startHub();
      await driftedByB(h);
      await send(h, '09:05:00', {
        checks: await checks([a]),
        records: {
          records: [{ kind: 'files', name: 'a-config', record: a }],
          unreadable: [{ kind: 'files', name: 'b-config' }],
        },
      });

      const { open, timeline } = await evaluate(h, '09:10:00');

      expect(open).toMatchObject([{ raisedAt: at('08:10:00'), subject: CONF }]);
      expect(timeline).toHaveLength(1);
    });

    test('stays as it is when the Hub does not know the shape of the record', async () => {
      await using h = await startHub();
      await driftedByB(h);
      await send(h, '09:05:00', { checks: await checks([a, b]) });
      await h.db.sql`
        UPDATE mirrored_records SET record = '{"name": "b-config", "files": "?"}'::jsonb
        WHERE kind = 'files' AND name = 'b-config'
      `;

      const { open } = await evaluate(h, '09:10:00');

      expect(open).toMatchObject([{ subject: CONF }]);
    });

    test('still raises Drift for another path a judged record shows changed', async () => {
      await using h = await startHub();
      await driftedByB(h);
      const c = filesRecord('a-config', CONF, ENV);
      await send(h, '09:05:00', {
        checks: await checks([c], mismatch('drifted', ENV, 'a-config')),
        records: {
          records: [{ kind: 'files', name: 'a-config', record: c }],
          unreadable: [{ kind: 'files', name: 'b-config' }],
        },
      });

      const { open } = await evaluate(h, '09:10:00');

      expect(subjects(open).toSorted()).toEqual([CONF, ENV]);
    });
  });

  test('stays as it is for a path a judged matching record and a record the checks did not judge both name', async () => {
    await using h = await startHub();
    const a = filesRecord('a-config', CONF);
    const b = filesRecord('b-config', CONF);
    await send(h, '08:05:00', {
      checks: await checks([a, b], mismatch('drifted', CONF, 'b-config')),
      records: set(a, b),
    });
    await evaluate(h, '08:10:00');
    // The checks hashed a-config again and found it matching, and have not
    // reached b-config yet.
    await send(h, '09:05:00', { checks: await checks([a]) });

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([{ raisedAt: at('08:10:00'), subject: CONF }]);
  });

  test('stays as it is for a record the Collector could not read, though the checks omit its paths', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', {
      checks: await checks([]),
      records: { records: [], unreadable: [{ kind: 'files', name: 'webapp-config' }] },
    });

    const { open, timeline } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([{ raisedAt: at('08:10:00'), subject: CONF }]);
    expect(timeline).toHaveLength(1);
  });

  test('stays as it is for a mirrored record whose shape the Hub does not know', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    await send(h, '09:05:00', { checks: await checks([WEBAPP]) });
    await h.db.sql`
      UPDATE mirrored_records SET record = '{"name": "webapp-config", "files": "?"}'::jsonb
      WHERE kind = 'files'
    `;

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([{ subject: CONF }]);
  });

  test('is cleared for a forgotten record beside records of other kinds, even unreadable ones', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    const job = {
      label: 'com.example.backup',
      name: 'backup',
      schedule: [{ hour: 3 }],
      scheduler: 'launchd',
    };
    await send(h, '09:05:00', {
      records: {
        records: [{ kind: 'job', name: 'backup', record: job }],
        unreadable: [{ kind: 'service', name: 'webapp' }],
      },
    });
    // A job record this Hub could not read as a files record, were it one.
    await h.db
      .sql`UPDATE mirrored_records SET record = '{"name": "backup"}'::jsonb WHERE kind = 'job'`;

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toEqual([]);
  });

  test('is not cleared or raised again when a path moves to another record before the new checks arrive', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    const emptied = filesRecord('webapp-config', ENV);
    const moved = filesRecord('webapp-moved', CONF);
    await send(h, '09:05:00', { records: set(emptied, moved) });

    const whileChecksLag = await evaluate(h, '09:10:00');
    await send(h, '09:15:00', {
      checks: await checks([emptied, moved], mismatch('drifted', CONF, 'webapp-moved')),
    });
    const afterChecks = await evaluate(h, '09:16:00');

    expect(whileChecksLag.open).toMatchObject([{ raisedAt: at('08:10:00'), subject: CONF }]);
    expect(whileChecksLag.timeline).toHaveLength(1);
    expect(afterChecks.open).toMatchObject([
      { raisedAt: at('08:10:00'), reason: expect.stringContaining('webapp-moved'), subject: CONF },
    ]);
    expect(afterChecks.timeline).toHaveLength(1);
  });

  test('are unknown when the checks judged an older version of the record', async () => {
    await using h = await startHub();
    const rerecorded: FilesRecord = {
      files: [{ path: CONF, sha256: 'b'.repeat(64) }],
      name: 'webapp-config',
    };
    await send(h, '08:05:00', {
      checks: await checks([WEBAPP], mismatch('drifted')),
      records: set(rerecorded),
    });
    const raised = await evaluate(h, '08:10:00');
    await send(h, '08:15:00', { checks: await checks([rerecorded]) });
    const settled = await evaluate(h, '08:16:00');

    expect(raised.open).toEqual([]);
    expect(settled.open).toEqual([]);
  });

  test('leave an open Drift as it is when the checks judged an older version that omits the path', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);
    const rerecorded: FilesRecord = {
      files: [{ path: CONF, sha256: 'b'.repeat(64) }],
      name: 'webapp-config',
    };
    await send(h, '09:05:00', { records: set(rerecorded) });

    const { open } = await evaluate(h, '09:10:00');

    expect(open).toMatchObject([{ subject: CONF }]);
  });
});

describe('the checks a Report carries', () => {
  test('keep the files the Hub can read when one has a state only a newer Collector knows', async () => {
    await using h = await startHub();
    const app = filesRecord('webapp-config', CONF, ENV);
    await send(h, '08:05:00', {
      checks: await checks([app], mismatch('sparkling', CONF), mismatch('drifted', ENV)),
      records: set(app),
    });

    const { open } = await evaluate(h, '08:10:00');

    expect(subjects(open)).toEqual([ENV]);
  });

  test('are ignored when sent earlier than the ones the Hub holds', async () => {
    await using h = await startHub();
    await send(h, '08:05:00', {
      checks: await checks([WEBAPP], mismatch('drifted')),
      records: set(WEBAPP),
    });
    await send(h, '08:06:00', { checks: await checks([WEBAPP]), sentAt: at('08:00:00') });

    const { open } = await evaluate(h, '08:10:00');

    expect(open).toMatchObject([{ subject: CONF }]);
  });
});

test('a System that cannot be judged does not stop the others, and the failure names it', async () => {
  await using h = await startHub();
  const sentChecks = await checks([WEBAPP], mismatch('drifted'));
  for (const system of ['laptop-1', 'server-1']) {
    h.clock.now = at('08:05:00');
    // oxlint-disable-next-line no-await-in-loop -- one System after the other.
    const response = await push(
      h.hub,
      {
        ...report(system, [at('08:05:00')]),
        checks: sentChecks,
        records: set(WEBAPP),
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

test('the page names the file and the state in the Condition and the Timeline', async () => {
  await using h = await startHub();
  await driftedAndEvaluated(h);

  const html = await page(h.hub);

  expect(html).toContain(`<strong>Drift</strong> <code>${CONF}</code> since`);
  expect(html).toContain(`Drift <code>${CONF}</code>: <span class="reason">Changed:`);
});
