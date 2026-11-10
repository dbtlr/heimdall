import { describe, expect, test } from 'bun:test';

import type { Change } from '../server/home-types.ts';
import { changeGroupId, changeLink, changeWords, groupChanges } from './home-changes.ts';

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

const version = (system: string, at: number, from = '0.10.0', to = '0.10.1'): Change => ({
  at,
  from,
  kind: 'version',
  service: 'heimdall-collector',
  system,
  to,
});

const stop = (
  system: string,
  at: number,
  service = 'heimdall-collector',
  ongoing = false,
): Change => ({
  at,
  kind: 'stop',
  ongoing,
  service,
  system,
});

const condition = (
  action: 'cleared' | 'raised',
  at: number,
  system = 'server-1',
  subject = '/etc/hosts',
): Change => ({
  action,
  at,
  condition: 'drift',
  conditionId: `${action}-${String(at)}-${subject}`,
  kind: 'condition',
  subject,
  system,
});

const words = (changes: Change[]) => groupChanges(changes).map(changeWords);

describe('groupChanges', () => {
  test('the same version change on several Systems within 10 minutes is one group, timed by its newest', () => {
    const groups = groupChanges([
      version('server-1', NOW),
      version('server-2', NOW + 4 * MINUTE),
      version('db-1', NOW + 9 * MINUTE),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.at).toBe(NOW + 9 * MINUTE);
    expect(groups[0]?.systems).toEqual(['db-1', 'server-1', 'server-2']);
    expect(changeWords(groups[0]!)).toEqual({
      detail: '3 Systems',
      mono: false,
      title: 'heimdall-collector 0.10.0 → 0.10.1',
    });
  });

  test('changes more than 10 minutes apart are separate groups', () => {
    expect(
      groupChanges([version('server-1', NOW), version('server-2', NOW + 11 * MINUTE)]),
    ).toHaveLength(2);
  });

  test('changes exactly 10 minutes apart are one group', () => {
    expect(
      groupChanges([version('server-1', NOW), version('server-2', NOW + 10 * MINUTE)]),
    ).toHaveLength(1);
  });

  test('different version transitions are separate groups', () => {
    expect(
      groupChanges([version('server-1', NOW), version('server-2', NOW, '0.9.0', '0.10.1')]),
    ).toHaveLength(2);
  });

  test("a version change folds its own Service's stops on the same System, and says each System restarted once", () => {
    const groups = groupChanges([
      version('server-1', NOW),
      version('server-2', NOW),
      stop('server-1', NOW - MINUTE),
      stop('server-2', NOW + MINUTE),
      // Another Service's stop, and one on a System whose version did not change, stay apart.
      stop('server-1', NOW - 2 * MINUTE, 't3code'),
      stop('db-1', NOW - 3 * MINUTE),
    ]);

    expect(groups.map(changeWords)).toEqual([
      {
        detail: 'server-1 and server-2, restarted once each',
        mono: false,
        title: 'heimdall-collector 0.10.0 → 0.10.1',
      },
      { detail: 'server-1', mono: false, title: 't3code restarted' },
      { detail: 'db-1', mono: false, title: 'heimdall-collector restarted' },
    ]);
  });

  test('a version change folds a stop exactly 10 minutes away', () => {
    expect(words([version('server-1', NOW), stop('server-1', NOW + 10 * MINUTE)])).toEqual([
      {
        detail: 'server-1, restarted once',
        mono: false,
        title: 'heimdall-collector 0.10.0 → 0.10.1',
      },
    ]);
  });

  test('of two version changes of one Service on one System, the nearer folds the stop', () => {
    expect(
      words([
        version('server-1', NOW),
        version('server-1', NOW + 15 * MINUTE, '0.10.1', '0.10.2'),
        stop('server-1', NOW + 9 * MINUTE),
      ]),
    ).toEqual([
      {
        detail: 'server-1, restarted once',
        mono: false,
        title: 'heimdall-collector 0.10.1 → 0.10.2',
      },
      { detail: 'server-1', mono: false, title: 'heimdall-collector 0.10.0 → 0.10.1' },
    ]);
  });

  test('a version change whose Systems did not each stop once says the total stops', () => {
    expect(
      words([
        version('server-1', NOW),
        version('server-2', NOW),
        stop('server-1', NOW - MINUTE),
        stop('server-1', NOW + MINUTE),
      ])[0]?.detail,
    ).toBe('server-1 and server-2, 2 restarts');
    expect(words([version('server-1', NOW), stop('server-1', NOW)])[0]?.detail).toBe(
      'server-1, restarted once',
    );
  });

  test('a lone stop is a restart of its Service on its System', () => {
    expect(words([stop('server-1', NOW, 't3code')])).toEqual([
      { detail: 'server-1', mono: false, title: 't3code restarted' },
    ]);
    expect(
      words([stop('server-1', NOW, 't3code'), stop('server-1', NOW + MINUTE, 't3code')])[0]?.title,
    ).toBe('t3code restarted 2 times');
  });

  test('a stop still ongoing says its Service stopped, not restarted, and no version change folds it', () => {
    expect(words([stop('server-1', NOW, 'dev-db', true)])).toEqual([
      { detail: 'server-1, still stopped', mono: false, title: 'dev-db stopped' },
    ]);
    expect(
      words([
        version('server-1', NOW),
        stop('server-1', NOW - MINUTE),
        stop('server-1', NOW + MINUTE, 'heimdall-collector', true),
      ]),
    ).toEqual([
      { detail: 'server-1, still stopped', mono: false, title: 'heimdall-collector stopped' },
      {
        detail: 'server-1, restarted once',
        mono: false,
        title: 'heimdall-collector 0.10.0 → 0.10.1',
      },
    ]);
  });

  test('a Condition raised then cleared is two changes, the clear first', () => {
    const groups = groupChanges([condition('raised', NOW), condition('cleared', NOW + 5 * MINUTE)]);

    expect(groups.map(changeWords)).toEqual([
      { detail: '/etc/hosts', mono: true, title: 'Drift cleared on server-1' },
      { detail: '/etc/hosts', mono: true, title: 'Drift raised on server-1' },
    ]);
    expect(groups.map(changeLink)).toEqual([
      {
        id: `cleared-${String(NOW + 5 * MINUTE)}-/etc/hosts`,
        system: 'server-1',
        to: 'condition',
      },
      { id: `raised-${String(NOW)}-/etc/hosts`, system: 'server-1', to: 'condition' },
    ]);
  });

  test('the same Condition change on several Systems names them and leads to the Timeline', () => {
    const [group] = groupChanges([
      condition('cleared', NOW),
      condition('cleared', NOW, 'db-1'),
      condition('cleared', NOW, 'edge-1'),
    ]);

    expect(changeWords(group!)).toEqual({
      detail: '3 Systems · /etc/hosts',
      mono: false,
      title: 'Drift cleared',
    });
    expect(changeLink(group!)).toEqual({ to: 'timeline' });
  });

  test('a Service change on one System leads to its Service page, on several to the Services page', () => {
    const [one] = groupChanges([stop('server-1', NOW, 't3code')]);
    const [several] = groupChanges([version('server-1', NOW), version('db-1', NOW)]);

    expect(changeLink(one!)).toEqual({ service: 't3code', system: 'server-1', to: 'service' });
    expect(changeLink(several!)).toEqual({ systems: ['db-1', 'server-1'], to: 'services' });
  });

  test('each group has its own id, even two changes of one kind on one System at one time', () => {
    const groups = groupChanges([
      condition('raised', NOW, 'server-1', '/etc/hosts'),
      condition('raised', NOW, 'server-1', '/etc/fstab'),
      version('server-1', NOW),
      version('server-1', NOW + 20 * MINUTE),
    ]);
    const ids = groups.map(changeGroupId);

    expect(
      groups
        .map(changeWords)
        .slice(1, 3)
        .map(({ title }) => title),
    ).toEqual(['Drift raised on server-1', 'Drift raised on server-1']);
    expect(new Set(ids).size).toBe(4);
  });

  test('groups come newest first, at most 5', () => {
    const groups = groupChanges(
      Array.from({ length: 7 }, (_, index) => stop('server-1', NOW + index * 20 * MINUTE)),
    );

    expect(groups.map(({ at }) => at)).toEqual(
      [6, 5, 4, 3, 2].map((index) => NOW + index * 20 * MINUTE),
    );
  });
});
