import { describe, expect, test } from 'bun:test';

import { filesRecordDigest } from '@heimdall/schema';
import type { FilesRecord } from '@heimdall/schema';

import { evaluateDrift, judgeDrift } from './drift.ts';
import type { DriftFacts } from './drift.ts';
import { unpair } from './pairing.ts';
import { listSystems, push, report, startHub } from './testing/hub.ts';
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

// Facts use a digest already read from the mirrored record; hashing stays in
// the database tests, where records and checks arrive in separate Reports.
const facts = (overrides: Partial<DriftFacts> = {}): DriftFacts => ({
  files: [],
  judged: new Map([['webapp-config', 'digest']]),
  open: [CONF],
  records: [{ digest: 'digest', name: 'webapp-config', paths: new Set([CONF]) }],
  recordsOverBudget: false,
  unreadable: false,
  ...overrides,
});

const file = (
  state: DriftFacts['files'][number]['state'],
  path = CONF,
  record = 'webapp-config',
) => ({ path, record, since: at('08:00:00'), state });

const changed = 'Changed: its content no longer matches the hash recorded in webapp-config.';

describe('judgeDrift', () => {
  test('raises changed and missing files with the path as subject and the record in the reason', () => {
    expect(judgeDrift(facts({ files: [file('drifted')] }))).toEqual(
      new Map([[CONF, { raise: changed }]]),
    );
    expect(judgeDrift(facts({ files: [file('missing')] }))).toEqual(
      new Map([[CONF, { raise: 'Missing: the file recorded in webapp-config does not exist.' }]]),
    );
  });

  test('judges each path once and takes the first changed record by code unit order', () => {
    const records = [
      { digest: 'a', name: 'a-config', paths: new Set([CONF, ENV]) },
      { digest: 'b', name: 'B-config', paths: new Set([CONF]) },
    ];
    const input = facts({
      files: [
        file('drifted', CONF, 'a-config'),
        file('missing', CONF, 'B-config'),
        file('drifted', ENV, 'a-config'),
      ],
      judged: new Map([
        ['a-config', 'a'],
        ['B-config', 'b'],
      ]),
      records,
    });
    const expected = new Map([
      [CONF, { raise: 'Missing: the file recorded in B-config does not exist.' }],
      [ENV, { raise: 'Changed: its content no longer matches the hash recorded in a-config.' }],
    ]);
    expect(judgeDrift(input)).toEqual(expected);
    expect(judgeDrift({ ...input, records: records.toReversed() })).toEqual(expected);
  });

  test('leaves unreadable files and directories alone', () => {
    expect(
      judgeDrift(
        facts({
          files: [file('unreadable'), file('unreadable', '/etc/webapp')],
          records: [
            { digest: 'digest', name: 'webapp-config', paths: new Set([CONF, '/etc/webapp']) },
          ],
        }),
      ),
    ).toEqual(new Map());
  });

  test('raises a changed path even if another record cannot judge it, in either record order', () => {
    const records = [
      { digest: 'a', name: 'a-config', paths: new Set([CONF]) },
      { digest: 'b', name: 'b-config', paths: new Set([CONF]) },
    ];
    const input = facts({
      judged: new Map([
        ['a-config', 'a'],
        ['b-config', 'b'],
      ]),
      records,
    });
    expect(
      judgeDrift({
        ...input,
        files: [file('unreadable', CONF, 'a-config'), file('drifted', CONF, 'b-config')],
      }),
    ).toEqual(
      new Map([
        [CONF, { raise: 'Changed: its content no longer matches the hash recorded in b-config.' }],
      ]),
    );
    expect(
      judgeDrift({
        ...input,
        files: [file('drifted', CONF, 'a-config'), file('unreadable', CONF, 'b-config')],
      }),
    ).toEqual(
      new Map([
        [CONF, { raise: 'Changed: its content no longer matches the hash recorded in a-config.' }],
      ]),
    );
  });

  test('clears only when every record naming a path was judged and matches', () => {
    const records = [
      { digest: 'a', name: 'a-config', paths: new Set([CONF]) },
      { digest: 'b', name: 'b-config', paths: new Set([CONF]) },
    ];
    expect(judgeDrift(facts({ judged: new Map([['a-config', 'a']]), records }))).toEqual(new Map());
    expect(
      judgeDrift(facts({ judged: new Map([['a-config', 'a']]), records: records.toReversed() })),
    ).toEqual(new Map());
    expect(
      judgeDrift(
        facts({
          judged: new Map([
            ['a-config', 'a'],
            ['b-config', 'b'],
          ]),
          records,
        }),
      ),
    ).toEqual(new Map([[CONF, 'clear']]));
  });

  test('judges no named path without hashed records, but clears a forgotten path even with stale checks', () => {
    expect(judgeDrift(facts({ judged: new Map() }))).toEqual(new Map());
    expect(
      judgeDrift(
        facts({
          files: [file('drifted')],
          judged: new Map(),
          records: [{ digest: 'other', name: 'other-config', paths: new Set([ENV]) }],
        }),
      ),
    ).toEqual(new Map([[CONF, 'clear']]));
    expect(judgeDrift(facts({ files: [file('drifted')], records: [] }))).toEqual(
      new Map([[CONF, 'clear']]),
    );
  });

  test('an unreadable files record blocks all clearing but does not block raising', () => {
    expect(judgeDrift(facts({ judged: new Map(), records: [], unreadable: true }))).toEqual(
      new Map(),
    );
    expect(judgeDrift(facts({ unreadable: true }))).toEqual(new Map());
    expect(judgeDrift(facts({ files: [file('drifted')], unreadable: true }))).toEqual(
      new Map([[CONF, { raise: changed }]]),
    );
    expect(
      judgeDrift(
        facts({
          files: [file('drifted', ENV)],
          records: [{ digest: 'digest', name: 'webapp-config', paths: new Set([CONF, ENV]) }],
          unreadable: true,
        }),
      ),
    ).toEqual(new Map([[ENV, { raise: changed }]]));
  });

  test('records over budget leave both changed and forgotten paths alone', () => {
    expect(
      judgeDrift(facts({ files: [file('drifted')], open: [ENV], recordsOverBudget: true })),
    ).toEqual(new Map());
  });

  test('ignores mismatches for paths the mirrored record does not name', () => {
    expect(judgeDrift(facts({ files: [file('drifted', ENV)] }))).toEqual(
      new Map([[CONF, 'clear']]),
    );
  });

  test('an older record digest cannot raise or clear until matching checks arrive', () => {
    const input = facts({ judged: new Map([['webapp-config', 'old-digest']]) });
    expect(judgeDrift(input)).toEqual(new Map());
    expect(judgeDrift({ ...input, files: [file('drifted')] })).toEqual(new Map());
    expect(judgeDrift(facts())).toEqual(new Map([[CONF, 'clear']]));
  });

  test('a path moved to another record stays unknown until its new checks arrive', () => {
    const input = facts({
      files: [file('drifted')],
      records: [
        { digest: 'emptied', name: 'webapp-config', paths: new Set([ENV]) },
        { digest: 'moved', name: 'webapp-moved', paths: new Set([CONF]) },
      ],
    });
    expect(judgeDrift(input)).toEqual(new Map());
    expect(
      judgeDrift({
        ...input,
        files: [file('drifted', CONF, 'webapp-moved')],
        judged: new Map([
          ['webapp-config', 'emptied'],
          ['webapp-moved', 'moved'],
        ]),
      }),
    ).toEqual(
      new Map<string, 'clear' | { raise: string }>([
        [ENV, 'clear'],
        [
          CONF,
          { raise: 'Changed: its content no longer matches the hash recorded in webapp-moved.' },
        ],
      ]),
    );
  });
});

describe('Drift wiring', () => {
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

  test('stays open on an unpaired System', async () => {
    await using h = await startHub();
    await driftedAndEvaluated(h);

    await unpair(h.db.sql, 'laptop-1');
    const { open } = await evaluate(h, '09:10:00');

    expect(subjects(open)).toEqual([CONF]);
    expect((await listSystems(h.db.sql)).find((s) => s.name === 'laptop-1')?.paired).toBe(false);
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

  test('judges nothing, and does not fail, for a System that sent checks but never records', async () => {
    await using h = await startHub();
    await send(h, '08:05:00', { checks: await checks([WEBAPP], mismatch('drifted')) });

    const { open } = await evaluate(h, '08:10:00');

    expect(open).toEqual([]);
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
