import { describe, expect, test } from 'bun:test';

import type { ServiceRecord } from '@heimdall/schema';

import { evaluateServiceConditions } from './service-conditions.ts';
import { listSystems } from './store.ts';
import { openGeneration, page, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';

// Times are on 10 October 2026.
const at = (time: string) => Date.parse(`2026-10-10T${time}Z`);

const SECOND = 1000;
const HOUR = 3_600_000;

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

// Sends laptop-1's Report at `time` on the Hub's clock with the given sections.
// `sentAt` is the Collector's clock when it sent, which a test can set apart
// from the Hub's.
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
  });
  await evaluate(h, '08:03:00');
};

const subjects = (open: { subject: string }[]) => open.map((c) => c.subject);

describe('Service down', () => {
  test('is raised for a Service whose check has failed for 2 minutes, with the Service as its subject', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: { services: [check('web', 'stopped', at('07:58:00'))] },
      records: set(WEB),
    });

    const { open } = await evaluate(h, '08:00:00');

    expect(open).toEqual([
      {
        kind: 'service_down',
        raisedAt: at('08:00:00'),
        reason: 'Stopped: ActiveState=failed.',
        subject: 'web',
      },
    ]);
  });

  test('is not raised until the check has failed for 2 minutes', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: { services: [check('web', 'stopped', at('07:59:00'))] },
      records: set(WEB),
    });

    await send(h, '08:00:59', {});
    const justBefore = await evaluate(h, '08:00:59');
    await send(h, '08:01:00', {});
    const atTwoMinutes = await evaluate(h, '08:01:00');

    expect(justBefore.open).toEqual([]);
    expect(subjects(atTwoMinutes.open)).toEqual(['web']);
  });

  test.each([
    ['ahead of the Hub', 3 * HOUR],
    ['behind the Hub', -3 * HOUR],
  ])(
    'counts how long the check has failed without trusting a System clock that is %s',
    async (_, skew) => {
      await using h = await startHub();
      // The check had failed for 90 seconds when the Collector sent it, by its own clock.
      await send(h, '08:00:00', {
        checks: { services: [check('web', 'stopped', at('08:00:00') + skew - 90 * SECOND)] },
        records: set(WEB),
        sentAt: at('08:00:00') + skew,
      });

      await send(h, '08:00:29', {});
      const early = await evaluate(h, '08:00:29');
      await send(h, '08:00:30', {});
      const due = await evaluate(h, '08:00:30');

      expect(early.open).toEqual([]);
      expect(subjects(due.open)).toEqual(['web']);
    },
  );

  test('counts the time since the Hub received the checks, though the Collector sends them only when they change', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: { services: [check('web', 'stopped', at('08:00:00'))] },
      records: set(WEB),
    });
    await send(h, '08:01:00', {});
    const first = await evaluate(h, '08:01:00');
    await send(h, '08:02:00', {});
    const later = await evaluate(h, '08:02:00');

    expect(first.open).toEqual([]);
    expect(subjects(later.open)).toEqual(['web']);
  });

  test('is not raised by silence after a Report that said stopped, even days later', async () => {
    await using h = await startHub();
    // The check had failed for 30 seconds when the Collector sent it, then the System went quiet.
    await send(h, '08:00:00', {
      checks: { services: [check('web', 'stopped', at('07:59:30'))] },
      records: set(WEB),
    });

    const minutes = await evaluate(h, '08:03:00');
    const days = await evaluate(h, at('08:00:00') + 3 * 24 * HOUR);

    expect(minutes.open).toEqual([]);
    expect(days.open).toEqual([]);
  });

  test('counts the time up to Last seen only, however much later it is judged', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: { services: [check('web', 'stopped', at('08:00:00'))] },
      records: set(WEB),
    });
    await send(h, '08:01:30', {});

    const { open } = await evaluate(h, '08:30:00');

    expect(open).toEqual([]);
  });

  test('is raised once Reports go on arriving for 2 minutes, which move Last seen', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: { services: [check('web', 'stopped', at('08:00:00'))] },
      records: set(WEB),
    });
    await send(h, '08:01:59', {});
    const before = await evaluate(h, '08:01:59');
    await send(h, '08:02:00', {});
    const after = await evaluate(h, '08:02:00');

    expect(before.open).toEqual([]);
    expect(subjects(after.open)).toEqual(['web']);
  });

  test('is raised once uploads that are not Reports move Last seen for 2 minutes', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: { services: [check('web', 'stopped', at('08:00:00'))] },
      records: set(WEB),
    });
    h.clock.now = at('08:02:00');
    await openGeneration(h.hub, '{', { token: 'laptop-token' });

    const { open } = await evaluate(h, '08:02:00');

    expect(subjects(open)).toEqual(['web']);
  });

  test('does not count time after the moment it is judged, though the System was seen later', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: { services: [check('web', 'stopped', at('08:00:00'))] },
      records: set(WEB),
    });
    await send(h, '08:05:00', {});

    const { open } = await evaluate(h, '08:01:00');

    expect(open).toEqual([]);
  });

  test('says in its reason what the Collector found', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: {
        services: [check('web', 'stopped', at('07:00:00'), 'LoadState=not-found')],
      },
      records: set(WEB),
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toMatchObject([{ reason: 'Stopped: LoadState=not-found.' }]);
  });

  test('takes the new reason when the detail changes, keeping when it was raised', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', {
      checks: { services: [check('web', 'stopped', at('07:55:00'), 'ActiveState=inactive')] },
    });

    const { open, timeline } = await evaluate(h, '08:05:00');

    expect(open).toMatchObject([
      { raisedAt: at('08:03:00'), reason: 'Stopped: ActiveState=inactive.', subject: 'web' },
    ]);
    expect(timeline).toHaveLength(1);
  });

  test('is one Condition for each Service', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: {
        services: [
          check('web', 'stopped', at('07:00:00')),
          check('db', 'stopped', at('07:00:00')),
          check('cache', 'up', at('07:00:00')),
        ],
      },
      records: set(WEB, DB, { name: 'cache', supervisor: 'systemd', unit: 'cache.service' }),
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(subjects(open).toSorted()).toEqual(['db', 'web']);
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

  test('stays as it is while the check is unknown, however long', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', {
      checks: { services: [check('web', 'unknown', at('08:03:30'), 'bus unavailable')] },
    });

    const { open, timeline } = await evaluate(h, '09:00:00');

    expect(open).toMatchObject([{ raisedAt: at('08:03:00'), subject: 'web' }]);
    expect(timeline).toHaveLength(1);
  });

  test('is not raised for a Service whose check is unknown or unchecked', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: {
        services: [
          check('web', 'unknown', at('07:00:00'), 'bus unavailable'),
          check('db', 'unchecked', at('07:00:00'), 'launchd is not checked'),
        ],
      },
      records: set(WEB, DB),
    });

    const { open } = await evaluate(h, '09:00:00');

    expect(open).toEqual([]);
  });

  test('stays as it is while a Service that failed again has not failed for 2 minutes', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', { checks: { services: [check('web', 'stopped', at('08:03:50'))] } });

    const { open } = await evaluate(h, '08:04:30');

    expect(open).toMatchObject([{ raisedAt: at('08:03:00'), subject: 'web' }]);
  });

  test('is not raised for a check of a Service the Hub mirrors no record for', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: { services: [check('web', 'stopped', at('07:00:00'))] },
      records: set(),
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toEqual([]);
  });

  test('is judged beside a files part over budget, which does not stop Services being judged', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: {
        overBudget: { files: { bytes: 2_000_000 } },
        services: [check('web', 'stopped', at('07:00:00'))],
      },
      records: set(WEB),
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(subjects(open)).toEqual(['web']);
  });

  test('and clears beside a files part over budget', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', {
      checks: {
        overBudget: { files: { bytes: 2_000_000 } },
        services: [check('web', 'up', at('08:03:30'))],
      },
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toEqual([]);
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
    await send(h, '08:00:00', { checks: { services: [check('web', 'stopped', at('07:00:00'))] } });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toEqual([]);
  });

  test('stays as it is while the System sent its records over budget', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', {
      checks: { services: [check('web', 'up', at('08:03:30'))] },
      records: { overBudget: { bytes: 9e6 } },
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

  test('does not clear for a forgotten Service while any service record is unreadable, since it may be that Service', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', {
      records: { records: [], unreadable: [{ kind: 'service', name: 'web' }] },
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toMatchObject([{ subject: 'web' }]);
  });

  test('clears a Service that recovered even while another service record is unreadable, since only a forgotten Service waits', async () => {
    await using h = await startHub();
    await downAndEvaluated(h);
    await send(h, '08:04:00', {
      checks: { services: [check('web', 'up', at('08:03:30'))] },
      records: { ...set(WEB), unreadable: [{ kind: 'service', name: 'other' }] },
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(open).toEqual([]);
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

  test('is raised for a Service even while another service record is unreadable', async () => {
    await using h = await startHub();
    await send(h, '08:00:00', {
      checks: { services: [check('web', 'stopped', at('07:00:00'))] },
      records: { ...set(WEB), unreadable: [{ kind: 'service', name: 'other' }] },
    });

    const { open } = await evaluate(h, '08:05:00');

    expect(subjects(open)).toEqual(['web']);
  });
});

test('the page and the Timeline name the Condition and the Service', async () => {
  await using h = await startHub();
  await downAndEvaluated(h);

  const html = await page(h.hub);
  expect(html).toContain('<strong>Service down</strong> <code>web</code> since');
  expect(html).toContain('Stopped: ActiveState=failed.');

  await send(h, '08:04:00', { checks: { services: [check('web', 'up', at('08:03:30'))] } });
  await evaluate(h, '08:05:00');
  expect(await page(h.hub)).toContain('Service down cleared <code>web</code>');
});
