import { describe, expect, test } from 'bun:test';

import type { ConditionMark } from '../server/fleet-overview-types.ts';
import type { ServiceChange } from '../server/home-types.ts';
import { levelSegments, packRows, systemEvents } from './system-events.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_800_000_000_000;
const WINDOW = { from: NOW - 12 * HOUR, to: NOW };
const at = (offset: number) => NOW - offset * HOUR;

const mark = (overrides: Partial<ConditionMark> & Pick<ConditionMark, 'kind'>): ConditionMark => ({
  clearedAt: undefined,
  id: overrides.kind,
  level: 'warning',
  raisedAt: NOW - HOUR,
  subject: '',
  transitions: [],
  ...overrides,
});

const version: ServiceChange = {
  at: NOW - 2 * HOUR,
  from: '1.8.2',
  kind: 'version',
  service: 'web',
  system: 'server-1',
  to: '1.8.3',
};

describe('systemEvents', () => {
  test('lists Conditions and Service changes together, the latest first, and leaves out what other places show', () => {
    const events = systemEvents(
      {
        changes: [
          version,
          {
            at: version.at + MINUTE,
            kind: 'stop',
            ongoing: false,
            service: 'web',
            system: 'server-1',
          },
        ],
        conditions: [
          mark({ clearedAt: NOW - 30 * MINUTE, kind: 'high_memory', raisedAt: NOW - HOUR }),
          mark({ kind: 'pending_update', level: 'note' }),
          mark({ kind: 'service_restarted', level: 'note', subject: 'web' }),
        ],
        paired: true,
      },
      WINDOW,
    );

    expect(events).toEqual([
      {
        at: NOW - HOUR,
        end: NOW - 30 * MINUTE,
        kind: 'condition',
        level: 'warning',
        text: 'High memory, warning',
      },
      { at: version.at, kind: 'change', text: 'web 1.8.2 → 1.8.3, restarted' },
    ]);
  });

  test('orders events by the latest time each shows, a cleared Condition by its clear and an open one by its raise, however long it has been open', () => {
    const events = systemEvents(
      {
        changes: [{ ...version, at: NOW - 10 * MINUTE }],
        conditions: [
          mark({ clearedAt: NOW - 5 * HOUR, kind: 'drift', raisedAt: NOW - 6 * HOUR }),
          mark({ kind: 'low_disk', raisedAt: WINDOW.from - 9 * HOUR, subject: '/backup' }),
          mark({ kind: 'job_failing', raisedAt: NOW - 3 * HOUR, subject: 'backup' }),
          mark({ clearedAt: NOW - 20 * MINUTE, kind: 'high_cpu', raisedAt: NOW - 2 * HOUR }),
        ],
        paired: true,
      },
      WINDOW,
    );

    expect(events.map(({ text }) => text)).toEqual([
      'web 1.8.2 → 1.8.3',
      'High CPU, warning',
      'Job failing backup, warning',
      'Drift, warning',
      'Low disk /backup, warning',
    ]);
  });

  test('keeps a Pending update or Reboot required that rose above a note, which the Maintenance line does not show', () => {
    const events = systemEvents(
      {
        changes: [],
        conditions: [
          mark({ kind: 'pending_update', level: 'warning' }),
          mark({
            kind: 'reboot_required',
            level: 'note',
            transitions: [
              { at: NOW - HOUR, backfilled: false, kind: 'raised', level: 'warning', reason: '' },
              {
                at: NOW - 20 * MINUTE,
                backfilled: false,
                kind: 'level_changed',
                level: 'note',
                previousLevel: 'warning',
                reason: '',
              },
            ],
          }),
        ],
        paired: true,
      },
      WINDOW,
    );

    expect(events.map(({ text }) => text).toSorted()).toEqual([
      'Pending update, warning',
      'Reboot required, warning',
    ]);
  });

  test("keeps an unpaired System's notes, which no Maintenance line or Services page shows", () => {
    const events = systemEvents(
      {
        changes: [],
        conditions: [
          mark({ kind: 'pending_update', level: 'note' }),
          mark({ kind: 'service_restarted', level: 'note', subject: 'web' }),
        ],
        paired: false,
      },
      WINDOW,
    );

    expect(events.map(({ text }) => text).toSorted()).toEqual([
      'Pending update, note',
      'Service restarted web, note',
    ]);
  });

  test('names a Condition by its subject and the highest level it reached', () => {
    const [event] = systemEvents(
      {
        changes: [],
        conditions: [
          mark({
            kind: 'job_failing',
            level: 'warning',
            subject: 'photos-sync',
            transitions: [
              { at: NOW - HOUR, backfilled: false, kind: 'raised', level: 'warning', reason: '' },
              {
                at: NOW - 20 * MINUTE,
                backfilled: false,
                kind: 'level_changed',
                level: 'alert',
                previousLevel: 'warning',
                reason: '',
              },
            ],
          }),
        ],
        paired: true,
      },
      WINDOW,
    );

    expect(event).toMatchObject({ level: 'alert', text: 'Job failing photos-sync, alert' });
  });

  test('leaves out a Condition that ended before the window', () => {
    const events = systemEvents(
      {
        changes: [],
        conditions: [
          mark({ clearedAt: WINDOW.from - HOUR, kind: 'drift', raisedAt: WINDOW.from - 2 * HOUR }),
        ],
        paired: true,
      },
      WINDOW,
    );

    expect(events).toEqual([]);
  });
});

describe('levelSegments', () => {
  test('splits a Condition at its level changes and ends the last where it was cleared', () => {
    const segments = levelSegments(
      mark({
        kind: 'high_cpu',
        transitions: [
          { at: at(3), backfilled: false, kind: 'raised', level: 'note', reason: '' },
          {
            at: at(2),
            backfilled: false,
            kind: 'level_changed',
            level: 'warning',
            previousLevel: 'note',
            reason: '',
          },
          { at: at(1), backfilled: false, kind: 'cleared', level: 'warning', reason: '' },
        ],
      }),
      at(1),
    );

    expect(segments).toEqual([
      { end: at(2), level: 'note', start: at(3) },
      { end: at(1), level: 'warning', start: at(2) },
    ]);
  });
});

describe('packRows', () => {
  test('puts spans that overlap on rows of their own and reuses a row once its span has ended', () => {
    expect(
      packRows([
        { end: 10, start: 0 },
        { end: 20, start: 5 },
        { end: 30, start: 12 },
        { end: 40, start: 25 },
      ]),
    ).toEqual([0, 1, 0, 1]);
  });
});
