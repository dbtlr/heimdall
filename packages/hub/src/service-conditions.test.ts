import { describe, expect, test } from 'bun:test';

import type { ServiceCheck, ServiceRecord } from '@heimdall/schema';

import { evaluateServiceConditions, judgeServiceDown } from './service-conditions.ts';
import type { ServiceDownFacts } from './service-conditions.ts';
import { listSystems, push, report, sampleTimes, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';

// Times are on 10 October 2026.
const at = (time: string) => Date.parse(`2026-10-10T${time}Z`);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const WEB: ServiceRecord = { name: 'web', supervisor: 'systemd', unit: 'web.service' };
const DB: ServiceRecord = { name: 'db', supervisor: 'systemd-user', unit: 'db.service' };

// A record set holding the given Service records, as a Collector sends it.
const set = (...records: ServiceRecord[]) => ({
  records: records.map((record) => ({ kind: 'service', name: record.name, record })),
  unreadable: [],
});

// A Service check as a Collector sends it, in the state it has held since
// `since` on the Collector's clock.
const check = (
  service: string,
  state: string,
  since: number,
  detail = state === 'up' ? 'ActiveState=active' : 'ActiveState=failed',
) => ({ check: 'supervisor', detail, service, since, state });

// A sample every 15 seconds from `from` until before `to` on the System's
// clock, which `skew` sets apart from the Hub's: the span the System was awake.
const awake = (from: string, to: string, skew = 0) => sampleTimes(at(from) + skew, at(to) + skew);

// Sends laptop-1's Report at `time` on the Hub's clock (a time on 10 October,
// or epoch milliseconds) with the given sections and the System's awake
// `samples`, a sample at `time` unless it says otherwise.
const send = async (
  h: Hub,
  time: string | number,
  sections: { checks?: unknown; records?: unknown; samples?: number[] },
) => {
  h.clock.now = typeof time === 'number' ? time : at(time);
  const response = await push(
    h.hub,
    {
      ...report('laptop-1', sections.samples ?? [h.clock.now]),
      sentAt: h.clock.now,
      ...(sections.records === undefined ? {} : { records: sections.records }),
      ...(sections.checks === undefined ? {} : { checks: sections.checks }),
    },
    { token: 'laptop-token' },
  );
  expect(response.status).toBe(200);
};

// Evaluates Service down at `time`, then answers laptop-1's open Conditions and Timeline.
const evaluate = async (h: Hub, time: string | number) => {
  h.clock.now = typeof time === 'number' ? time : at(time);
  await evaluateServiceConditions(h.db.sql, () => h.clock.now);
  const found = (await listSystems(h.db.sql)).find((s) => s.name === 'laptop-1');
  return { open: found?.conditions ?? [], timeline: found?.timeline ?? [] };
};

// Service down raised for web at 08:03, for the tests that start from an open Condition.
const downAndEvaluated = async (h: Hub) => {
  await send(h, '08:00:00', {
    checks: { services: [check('web', 'stopped', at('07:55:00'))] },
    records: set(WEB),
    samples: awake('07:55:00', '08:00:00'),
  });
  await evaluate(h, '08:03:00');
};

const subjects = (open: { subject: string }[]) => open.map((c) => c.subject);

// A health check of a Service as a Collector sends it.
const health = (service: string, state: string, since: number, detail = 'HTTP 503') => ({
  check: 'health',
  detail,
  service,
  since,
  state,
});

describe('Service down wiring', () => {
  test('is raised for a Service whose check has failed for 2 minutes of awake time, with the Service as its subject', async () => {
    await using h = await startHub();
    await send(h, '08:02:30', {
      checks: { services: [check('web', 'stopped', at('08:00:30'))] },
      records: set(WEB),
      samples: awake('08:00:45', '08:02:45'),
    });

    const { open } = await evaluate(h, '08:02:30');

    expect(open).toEqual([
      {
        kind: 'service_down',
        raisedAt: at('08:02:30'),
        reason: 'Stopped: ActiveState=failed.',
        subject: 'web',
      },
    ]);
  });

  test('is raised for a Service whose supervisor is up but whose health URL has failed for 2 minutes', async () => {
    await using h = await startHub();
    await send(h, '08:02:30', {
      checks: {
        services: [check('web', 'up', at('07:00:00')), health('web', 'unhealthy', at('08:00:30'))],
      },
      records: set(WEB),
      samples: awake('08:00:45', '08:02:45'),
    });

    const { open } = await evaluate(h, '08:02:30');

    expect(open).toMatchObject([{ reason: 'Unhealthy: HTTP 503.', subject: 'web' }]);
  });

  // The check began mid-bucket, at 08:00:30, so a count in whole 5-minute
  // buckets would wait for the next one.
  test('is raised at exactly 8 samples after the check began, and not at 7, wherever it began in a 5-minute bucket', async () => {
    await using h = await startHub();
    await send(h, '08:02:15', {
      checks: { services: [check('web', 'stopped', at('08:00:30'))] },
      records: set(WEB),
      samples: awake('08:00:45', '08:02:30'),
    });
    const seven = await evaluate(h, '08:02:15');
    await send(h, '08:02:30', { samples: [at('08:02:30')] });
    const eight = await evaluate(h, '08:02:30');

    expect(seven.open).toEqual([]);
    expect(subjects(eight.open)).toEqual(['web']);
  });

  test('does not count a sample taken at the moment the check began', async () => {
    await using h = await startHub();
    await send(h, '08:01:45', {
      checks: { services: [check('web', 'stopped', at('08:00:00'))] },
      records: set(WEB),
      samples: awake('08:00:00', '08:02:00'),
    });

    const { open } = await evaluate(h, '08:01:45');

    expect(open).toEqual([]);
  });

  test("counts only the System's own samples, not another System's", async () => {
    await using h = await startHub();
    await send(h, '08:02:15', {
      checks: { services: [check('web', 'stopped', at('08:00:30'))] },
      records: set(WEB),
      samples: awake('08:00:45', '08:02:30'),
    });
    // server-1 took 8 samples after laptop-1's check began, while laptop-1 took 7.
    h.clock.now = at('08:02:30');
    const response = await push(h.hub, report('server-1', awake('08:00:45', '08:02:45')), {
      token: 'server-token',
    });
    expect(response.status).toBe(200);

    const { open } = await evaluate(h, '08:02:30');

    expect(open).toEqual([]);
  });

  test('counts samples on the System clock alone, which is ahead of the Hub', async () => {
    await using h = await startHub();
    const skew = 3 * HOUR;
    await send(h, '08:02:15', {
      checks: { services: [check('web', 'stopped', at('08:00:30') + skew)] },
      records: set(WEB),
      samples: awake('08:00:45', '08:02:30', skew),
    });
    const early = await evaluate(h, '08:02:15');
    await send(h, '08:02:30', { samples: [at('08:02:30') + skew] });
    const due = await evaluate(h, '08:02:30');

    expect(early.open).toEqual([]);
    expect(subjects(due.open)).toEqual(['web']);
  });

  test('is not raised by silence after a Report that said stopped, even days later', async () => {
    await using h = await startHub();
    // The check had failed for 30 seconds when the Collector sent it, then the System went quiet.
    await send(h, '08:00:00', {
      checks: { services: [check('web', 'stopped', at('07:59:30'))] },
      records: set(WEB),
      samples: awake('07:59:30', '08:00:00'),
    });

    const minutes = await evaluate(h, '08:03:00');
    const days = await evaluate(h, at('08:00:00') + 3 * DAY);

    expect(minutes.open).toEqual([]);
    expect(days.open).toEqual([]);
  });

  test('counts no time a System slept: after 60 s of failing and 2 days asleep it is not raised in its first minute awake', async () => {
    await using h = await startHub();
    await send(h, '08:01:00', {
      checks: { services: [check('web', 'stopped', at('08:00:00'))] },
      records: set(WEB),
      samples: awake('08:00:15', '08:01:15'),
    });
    const wake = at('08:00:00') + 2 * DAY;
    // The first Report after waking moves Last seen by two days, which counts nothing.
    await send(h, wake + 45_000, { samples: sampleTimes(wake, wake + 45_000) });
    const early = await evaluate(h, wake + 45_000);
    await send(h, wake + 60_000, { samples: sampleTimes(wake + 45_000, wake + 60_000) });
    const due = await evaluate(h, wake + 60_000);

    expect(early.open).toEqual([]);
    expect(subjects(due.open)).toEqual(['web']);
  });

  test('clears when the check passes, and the Timeline keeps both', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', { checks: { services: [check('web', 'up', at('08:03:30'))] } });

    const { open, timeline } = await evaluate(h, '08:05:00');

    expect(open).toEqual([]);
    expect(timeline).toMatchObject([
      { at: at('08:05:00'), condition: 'service_down', kind: 'cleared', subject: 'web' },
      { at: at('08:03:00'), condition: 'service_down', kind: 'raised', subject: 'web' },
    ]);
  });

  test('is not raised for a check of a Service the Hub mirrors no record for', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: { services: [check('web', 'stopped', at('07:55:00'))] },
      records: set(),
      samples: awake('07:55:00', '08:00:00'),
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toEqual([]);
  });

  test('is judged beside a files part over budget, which does not stop Services being judged', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: {
        overBudget: { files: { bytes: 2_000_000 } },
        services: [check('web', 'stopped', at('07:55:00'))],
      },
      records: set(WEB),
      samples: awake('07:55:00', '08:00:00'),
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(subjects(open)).toEqual(['web']);
  });

  test('stays as it is while the services part is over budget', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', { checks: { overBudget: { services: { bytes: 2_000_000 } } } });

    const { open } = await evaluate(h, '09:00:00');

    expect(open).toMatchObject([{ raisedAt: at('08:03:00'), subject: 'web' }]);
  });

  test('stays as it is while the section carries no services part, as one from a Collector without Service checks does', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', { checks: { files: [] } });

    const { open } = await evaluate(h, '09:00:00');

    expect(open).toMatchObject([{ subject: 'web' }]);
  });

  test('stays as it is when a Report carries no checks, and while the System has sent none', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', {});
    const noChecks = await evaluate(h, '09:00:00');
    await using none = await startHub();
    await send(none, '08:00:00', { records: set(WEB) });
    const neverSent = await evaluate(none, '09:00:00');

    expect(noChecks.open).toMatchObject([{ subject: 'web' }]);
    expect(neverSent).toEqual({ open: [], timeline: [] });
  });

  test('judges nothing, and does not fail, for a System that sent checks but never records', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', { checks: { services: [check('web', 'stopped', at('07:55:00'))] } });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toEqual([]);
  });

  test('stays as it is while the System sent its records over budget', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', {
      checks: { services: [check('web', 'up', at('08:03:30'))] },
      records: { overBudget: { bytes: 9e6 } },
      samples: awake('07:55:00', '08:00:00'),
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toMatchObject([{ subject: 'web' }]);
  });

  test('clears when the Service is forgotten', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', { records: set(DB) });

    const { open, timeline } = await evaluate(h, '08:05:00');

    expect(open).toEqual([]);
    expect(timeline).toMatchObject([
      { condition: 'service_down', kind: 'cleared', subject: 'web' },
      {},
    ]);
  });

  test('clears when the Service is forgotten while the services part is over budget', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', {
      checks: { overBudget: { services: { bytes: 2_000_000 } } },
      records: set(DB),
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toEqual([]);
  });

  test('does not clear for a forgotten Service while a service record is unreadable, since it may be that Service', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', {
      records: { records: [], unreadable: [{ kind: 'service', name: 'web' }] },
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toMatchObject([{ subject: 'web' }]);
  });

  test('does not clear for a forgotten Service while a service record has a shape the Hub does not know', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', {
      records: {
        records: [
          { kind: 'service', name: 'cache', record: { name: 'cache', supervisor: 'runit' } },
        ],
        unreadable: [],
      },
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toMatchObject([{ subject: 'web' }]);
  });

  test('clears a forgotten Service while only a record of another kind is unreadable', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', {
      records: { records: [], unreadable: [{ kind: 'file', name: 'web' }] },
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toEqual([]);
  });
});

const UP = 1000;
const CUTOFF = 5000;

// A stored Service check of the supervisor kind, unless `kind` says health.
const stored = (
  service: string,
  state: ServiceCheck['state'],
  since: number,
  { detail, kind = 'supervisor' }: { detail?: string; kind?: ServiceCheck['check'] } = {},
): ServiceCheck => ({
  check: kind,
  detail: detail ?? (state === 'up' ? 'ActiveState=active' : 'ActiveState=failed'),
  service,
  since,
  state,
});

const FAILED = 4000;
const RECENT = CUTOFF;

const judge = (changes: Partial<ServiceDownFacts> = {}) =>
  judgeServiceDown({
    checks: [],
    mirrored: ['web'],
    open: [],
    recordsOverBudget: false,
    sampleCutoff: CUTOFF,
    unreadable: false,
    ...changes,
  });

const plain = (judged: ReturnType<typeof judgeServiceDown>) => Object.fromEntries(judged);

describe('judgeServiceDown', () => {
  test('raises a Service whose check began before the sample cutoff, with the state and detail as the reason', () => {
    expect(judge({ checks: [stored('web', 'stopped', FAILED)] })).toEqual(
      new Map([['web', { raise: 'Stopped: ActiveState=failed.' }]]),
    );
    expect(
      judge({
        checks: [stored('web', 'unhealthy', FAILED, { detail: 'HTTP 503', kind: 'health' })],
      }),
    ).toEqual(new Map([['web', { raise: 'Unhealthy: HTTP 503.' }]]));
  });

  test('raises only a check that began strictly before the cutoff, and none while the System took too few samples', () => {
    expect(judge({ checks: [stored('web', 'stopped', CUTOFF - 1)] }).get('web')).toBeDefined();
    expect(judge({ checks: [stored('web', 'stopped', CUTOFF)] }).size).toBe(0);
    expect(judge({ checks: [stored('web', 'stopped', 0)], sampleCutoff: undefined }).size).toBe(0);
  });

  test('judges each mirrored Service on its own checks', () => {
    const judged = judge({
      checks: [
        stored('web', 'stopped', FAILED),
        stored('db', 'stopped', FAILED),
        stored('cache', 'up', UP),
      ],
      mirrored: ['web', 'db', 'cache'],
    });

    expect(plain(judged)).toEqual({
      cache: 'clear',
      db: { raise: 'Stopped: ActiveState=failed.' },
      web: { raise: 'Stopped: ActiveState=failed.' },
    });
  });

  test('names the supervisor check when both checks have failed long enough, whatever the order they are listed in', () => {
    const checks = [
      stored('web', 'unhealthy', FAILED, { kind: 'health' }),
      stored('web', 'stopped', FAILED - 1000),
    ];

    expect(judge({ checks }).get('web')).toEqual({ raise: 'Stopped: ActiveState=failed.' });
  });

  test('names the health check when the supervisor check has failed for less than 2 minutes', () => {
    const checks = [
      stored('web', 'stopped', RECENT),
      stored('web', 'unhealthy', FAILED, { detail: 'HTTP 503', kind: 'health' }),
    ];

    expect(judge({ checks }).get('web')).toEqual({ raise: 'Unhealthy: HTTP 503.' });
  });

  test('raises a Service with only a failing health check, or while its supervisor check is unknown', () => {
    const unhealthy = stored('web', 'unhealthy', FAILED, { detail: 'refused', kind: 'health' });

    expect(judge({ checks: [unhealthy] }).get('web')).toEqual({ raise: 'Unhealthy: refused.' });
    expect(judge({ checks: [stored('web', 'unknown', FAILED), unhealthy] }).get('web')).toEqual({
      raise: 'Unhealthy: refused.',
    });
  });

  test('clears a Service when every check that was made passes, even with an unchecked supervisor', () => {
    expect(
      judge({
        checks: [stored('web', 'up', UP), stored('web', 'up', UP, { kind: 'health' })],
      }).get('web'),
    ).toBe('clear');
    expect(
      judge({
        checks: [stored('web', 'unchecked', UP), stored('web', 'up', UP, { kind: 'health' })],
      }).get('web'),
    ).toBe('clear');
  });

  test('leaves a Service as it is while any check is unknown, unchecked, or failed only recently, or none was made', () => {
    const unhealthyRecent = stored('web', 'unhealthy', RECENT, { kind: 'health' });
    const cases = [
      [stored('web', 'unknown', FAILED)],
      [stored('web', 'unchecked', FAILED)],
      [stored('web', 'unknown', FAILED), stored('web', 'up', UP, { kind: 'health' })],
      [stored('web', 'stopped', RECENT)],
      [stored('web', 'up', UP), unhealthyRecent],
      [],
    ];

    for (const checks of cases) {
      expect(judge({ checks, open: ['web'] }).size).toBe(0);
    }
  });

  test('does not clear while either check still fails', () => {
    const checks = [
      stored('web', 'up', UP),
      stored('web', 'unhealthy', RECENT, { kind: 'health' }),
    ];

    expect(judge({ checks }).get('web')).toBeUndefined();
  });

  test('judges only a Service the Hub mirrors a record for', () => {
    expect(judge({ checks: [stored('web', 'stopped', FAILED)], mirrored: [] }).size).toBe(0);
  });

  test('judges nothing while the System sent its records over budget, not even a forgotten Service', () => {
    expect(
      judge({
        checks: [stored('web', 'up', UP)],
        mirrored: ['web'],
        open: ['web', 'gone'],
        recordsOverBudget: true,
      }).size,
    ).toBe(0);
  });

  test('clears a Service with no record left even when there are no checks to read, as when the services part is over budget', () => {
    expect(judge({ mirrored: ['db'], open: ['web'] })).toEqual(new Map([['web', 'clear']]));
  });

  test('does not clear a forgotten Service while a service record is unreadable', () => {
    expect(judge({ mirrored: [], open: ['web'], unreadable: true }).size).toBe(0);
  });

  test('still raises and clears Services with a record while another service record is unreadable', () => {
    const judged = judge({
      checks: [stored('web', 'stopped', FAILED), stored('db', 'up', UP)],
      mirrored: ['web', 'db'],
      open: ['db'],
      unreadable: true,
    });

    expect(plain(judged)).toEqual({ db: 'clear', web: { raise: 'Stopped: ActiveState=failed.' } });
  });
});
