import { expect, test } from 'bun:test';

import type { ConditionLevel } from '@heimdall/schema';

import { clear, raise, recordClosedOccurrence } from './conditions.ts';
import { clipBytes, deliverAlerts } from './delivery.ts';
import type { Message } from './delivery.ts';
import { failure, migrate, NOW, storeToken, unpair } from './testing/hub.ts';
import { testDatabase } from './testing/postgres.ts';

const DASHBOARD = new URL('https://dashboard.example/');

const at = (minutes: number) => NOW + minutes * 60_000;

// A database with server-1 and laptop-1 paired, and a delivery pass that sends
// to `sent` unless `channel.down` holds delivery.
const setup = async () => {
  const db = await testDatabase();
  await migrate(db.sql);
  await storeToken(db.sql, { pairedAt: NOW, system: 'server-1', token: 'server-token' });
  await storeToken(db.sql, { pairedAt: NOW, system: 'laptop-1', token: 'laptop-token' });
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('server-1', now()), ('laptop-1', now())`;
  const sent: Message[] = [];
  // `down` refuses every message, `refuses` only those of one priority.
  const channel: { down: boolean; refuses: Message['priority'] | undefined } = {
    down: false,
    refuses: undefined,
  };
  const pass = (minutes: number) =>
    deliverAlerts(db.sql, {
      dashboard: DASHBOARD,
      now: at(minutes),
      send: async (message) => {
        if (channel.down || channel.refuses === message.priority) {
          throw new Error('ntfy is unreachable');
        }
        sent.push(message);
      },
    });
  // Service down for nginx on server-1, raised (or cleared) at a minute.
  const down = (minutes: number, service = 'nginx', system = 'server-1') =>
    db.sql.begin((tx) =>
      raise(tx, {
        kind: 'service_down',
        now: new Date(at(minutes)),
        reason: `${service}: inactive (dead).`,
        subject: service,
        system,
      }),
    );
  const up = (minutes: number, service = 'nginx', system = 'server-1') =>
    db.sql.begin((tx) =>
      clear(tx, { kind: 'service_down', now: new Date(at(minutes)), subject: service, system }),
    );
  const disk = (minutes: number, level: ConditionLevel) =>
    db.sql.begin((tx) =>
      raise(tx, {
        kind: 'low_disk',
        level,
        now: new Date(at(minutes)),
        reason: `Disk at ${level}.`,
        subject: '/',
        system: 'server-1',
      }),
    );
  const conditionId = async (kind: string) => {
    const [row]: { id: string }[] = await db.sql`
      SELECT id::text FROM conditions WHERE kind = ${kind} ORDER BY id DESC LIMIT 1
    `;
    return row?.id;
  };
  return {
    channel,
    conditionId,
    db,
    disk,
    down,
    pass,
    sent,
    up,
    [Symbol.asyncDispose]: () => db[Symbol.asyncDispose](),
  };
};

test('a Condition reaching alert sends one high-priority push that opens its page, and nothing more while it stays', async () => {
  await using d = await setup();
  await d.down(0);

  await d.pass(0.5);
  await d.pass(1);
  await d.pass(30);

  expect(d.sent).toEqual([
    {
      click: `https://dashboard.example/systems/server-1/conditions/${String(await d.conditionId('service_down'))}`,
      message: 'nginx: inactive (dead). At alert for under a minute.',
      priority: 'high',
      title: 'Service down on server-1: nginx',
    },
  ]);
});

test('notes and warnings are never pushed', async () => {
  await using d = await setup();
  await d.disk(0, 'note');
  await d.pass(1);
  await d.disk(2, 'warning');
  await d.pass(3);

  expect(d.sent).toEqual([]);
});

test('a recovered message goes out once the identity has stayed below alert for 10 minutes, and only once', async () => {
  await using d = await setup();
  await d.down(0);
  await d.pass(0.5);
  await d.up(5);

  await d.pass(14.9);
  expect(d.sent).toHaveLength(1);

  await d.pass(15);
  await d.pass(40);
  expect(d.sent.slice(1)).toEqual([
    {
      click: `https://dashboard.example/systems/server-1/conditions/${String(await d.conditionId('service_down'))}`,
      message: 'Cleared. Reached alert once.',
      priority: 'low',
      title: 'Recovered: Service down on server-1: nginx',
    },
  ]);
});

test('returns to alert within a delivery are counted in its recovered message, never pushed', async () => {
  await using d = await setup();
  await d.down(0);
  await d.pass(0.5);
  await d.up(2);
  await d.pass(3);
  await d.down(5);
  await d.pass(6);
  await d.up(7);
  await d.pass(16.9);
  await d.down(16.95);
  await d.up(17);
  await d.pass(26.9);
  expect(d.sent.map((m) => m.priority)).toEqual(['high']);

  await d.pass(27);

  expect(d.sent.map((m) => m.priority)).toEqual(['high', 'low']);
  expect(d.sent[1]?.message).toBe('Cleared. Reached alert 3 times.');
  // The link opens the latest occurrence.
  expect(d.sent[1]?.click).toEndWith(`/conditions/${String(await d.conditionId('service_down'))}`);
});

test('a step down from alert recovers after 10 minutes, saying the level it is at now', async () => {
  await using d = await setup();
  await d.disk(0, 'alert');
  await d.pass(0.5);
  await d.disk(2, 'warning');
  await d.pass(11.9);
  await d.disk(12, 'alert');
  await d.disk(13, 'warning');
  await d.pass(22.9);
  expect(d.sent).toHaveLength(1);

  await d.pass(23);

  expect(d.sent[1]).toMatchObject({
    message: 'Now at warning. Reached alert twice.',
    priority: 'low',
    title: 'Recovered: Low disk on server-1: /',
  });
});

test('reaching alert again after a delivery recovered opens a new one', async () => {
  await using d = await setup();
  await d.down(0);
  await d.pass(0.5);
  await d.up(1);
  await d.pass(11);
  await d.down(20);

  await d.pass(20.5);

  expect(d.sent.map((m) => m.priority)).toEqual(['high', 'low', 'high']);
});

test('a Condition raised and cleared while delivery was held sends nothing', async () => {
  await using d = await setup();
  d.channel.down = true;
  await d.down(0);
  expect(await failure(d.pass(0.5))).toEqual(new Error('ntfy is unreachable'));
  await d.up(3);
  d.channel.down = false;

  await d.pass(4);
  await d.pass(30);

  expect(d.sent).toEqual([]);
});

test('a Condition still at alert when delivery resumes sends one push saying how long it has been at alert', async () => {
  await using d = await setup();
  d.channel.down = true;
  await d.down(0);
  expect(await failure(d.pass(1))).toBeInstanceOf(Error);
  d.channel.down = false;

  await d.pass(75);
  await d.pass(76);

  expect(d.sent.map((m) => m.message)).toEqual([
    'nginx: inactive (dead). At alert for 1 h 15 min.',
  ]);
});

test('a delivery pushed before a hold sends its recovered message when the hold ends', async () => {
  await using d = await setup();
  await d.down(0);
  await d.pass(0.5);
  await d.up(2);
  d.channel.down = true;
  expect(await failure(d.pass(12))).toBeInstanceOf(Error);
  d.channel.down = false;

  await d.pass(30);
  await d.pass(31);

  expect(d.sent.map((m) => m.title)).toEqual([
    'Service down on server-1: nginx',
    'Recovered: Service down on server-1: nginx',
  ]);
});

test('what comes due in one pass goes out as one message per priority, recovered first, opening the Fleet page', async () => {
  await using d = await setup();
  await d.down(0, 'nginx');
  await d.down(0, 'postgres');
  await d.pass(0.5);
  await d.up(1, 'nginx');
  await d.up(1, 'postgres');
  await d.down(10, 'redis');
  await d.down(10, 'sshd', 'laptop-1');

  await d.pass(11);

  expect(d.sent).toEqual([
    {
      click: 'https://dashboard.example/',
      message: [
        'Service down on server-1: nginx. nginx: inactive (dead). At alert for under a minute.',
        'Service down on server-1: postgres. postgres: inactive (dead). At alert for under a minute.',
      ].join('\n'),
      priority: 'high',
      title: '2 alerts',
    },
    {
      click: 'https://dashboard.example/',
      message: [
        'Service down on server-1: nginx. Cleared. Reached alert once.',
        'Service down on server-1: postgres. Cleared. Reached alert once.',
      ].join('\n'),
      priority: 'low',
      title: '2 recovered',
    },
    {
      click: 'https://dashboard.example/',
      message: [
        'Service down on laptop-1: sshd. sshd: inactive (dead). At alert for 1 min.',
        'Service down on server-1: redis. redis: inactive (dead). At alert for 1 min.',
      ].join('\n'),
      priority: 'high',
      title: '2 alerts',
    },
  ]);
});

test('a first pass sends one message for the Conditions already open at alert, and closed occurrences never send', async () => {
  await using d = await setup();
  await d.db.sql.begin((tx) =>
    recordClosedOccurrence(tx, {
      kind: 'service_down',
      now: new Date(at(-120)),
      steps: [{ level: 'alert', reason: 'cron: inactive (dead).' }],
      subject: 'cron',
      system: 'server-1',
    }),
  );
  await d.down(-90, 'nginx');
  await d.down(-60, 'sshd', 'laptop-1');

  await d.pass(0);
  await d.pass(20);

  expect(d.sent).toEqual([
    {
      click: 'https://dashboard.example/',
      message: [
        'Service down on laptop-1: sshd. sshd: inactive (dead). At alert for 1 h.',
        'Service down on server-1: nginx. nginx: inactive (dead). At alert for 1 h 30 min.',
      ].join('\n'),
      priority: 'high',
      title: '2 alerts',
    },
  ]);
});

test('an unpaired System is not delivered', async () => {
  await using d = await setup();
  await d.down(0, 'sshd', 'laptop-1');
  await unpair(d.db.sql, 'laptop-1');

  await d.pass(1);

  expect(d.sent).toEqual([]);
});

test('unpairing a System closes its open delivery without a message, so pairing it again starts afresh', async () => {
  await using d = await setup();
  await d.down(0, 'sshd', 'laptop-1');
  await d.pass(0.5);
  await unpair(d.db.sql, 'laptop-1');
  await d.pass(1);
  await d.up(2, 'sshd', 'laptop-1');
  await d.pass(30);
  await storeToken(d.db.sql, { pairedAt: at(40), system: 'laptop-1', token: 'laptop-token-2' });
  await d.down(41, 'sshd', 'laptop-1');

  await d.pass(41.5);

  expect(d.sent.map((m) => m.title)).toEqual([
    'Service down on laptop-1: sshd',
    'Service down on laptop-1: sshd',
  ]);
});

test('a delivery that closed while delivery was held sends its recovered message before the push for its return', async () => {
  await using d = await setup();
  await d.down(0);
  await d.pass(0.5);
  await d.up(2);
  d.channel.down = true;
  expect(await failure(d.pass(12))).toBeInstanceOf(Error);
  await d.down(20);
  d.channel.down = false;

  await d.pass(60);

  expect(d.sent.slice(1).map((m) => [m.title, m.message])).toEqual([
    [
      'Recovered: Service down on server-1: nginx',
      'Below alert for 10 minutes, now back at alert. Reached alert once.',
    ],
    ['Service down on server-1: nginx', 'nginx: inactive (dead). At alert for 40 min.'],
  ]);
});

test('a step up from warning to alert pushes', async () => {
  await using d = await setup();
  await d.disk(0, 'warning');
  await d.pass(1);
  await d.disk(2, 'alert');

  await d.pass(3);

  expect(d.sent.map((m) => [m.title, m.message])).toEqual([
    ['Low disk on server-1: /', 'Disk at alert. At alert for 1 min.'],
  ]);
});

test('a refused recovered message holds back neither the pushes nor its own retry', async () => {
  await using d = await setup();
  await d.down(0, 'nginx');
  await d.pass(0.5);
  await d.up(1, 'nginx');
  await d.down(11, 'postgres');
  d.channel.refuses = 'low';
  expect(await failure(d.pass(11.5))).toEqual(new Error('ntfy is unreachable'));
  d.channel.refuses = undefined;

  await d.pass(12);

  expect(d.sent.map((m) => m.title)).toEqual([
    'Service down on server-1: nginx',
    'Service down on server-1: postgres',
    'Recovered: Service down on server-1: nginx',
  ]);
});

test('a batch lists ten lines and counts the rest', async () => {
  await using d = await setup();
  const services = Array.from({ length: 12 }, (_, i) => `svc-${String(i).padStart(2, '0')}`);
  for (const service of services) {
    // oxlint-disable-next-line no-await-in-loop -- raised in order.
    await d.down(0, service);
  }

  await d.pass(0.5);

  const lines = d.sent[0]?.message.split('\n') ?? [];
  expect(d.sent[0]?.title).toBe('12 alerts');
  expect(lines).toHaveLength(11);
  expect(lines.at(-1)).toBe('And 2 more.');
});

test('Hub clock skew names whose clock is wrong', async () => {
  await using d = await setup();
  await d.db.sql.begin((tx) =>
    raise(tx, {
      kind: 'clock_skew',
      level: 'alert',
      now: new Date(at(0)),
      reason: "The Hub's clock is 6 min behind.",
      subject: 'hub',
      system: 'server-1',
    }),
  );

  await d.pass(1);

  expect(d.sent[0]?.title).toBe("Clock skew on server-1: Hub's clock");
});

test('a return to alert stamped earlier by a clock stepped back still keeps the delivery open', async () => {
  await using d = await setup();
  await d.down(0);
  await d.pass(0.5);
  await d.up(5);
  await d.down(3);

  await d.pass(20);

  expect(d.sent.map((m) => m.priority)).toEqual(['high']);
});

test('a batch of long reasons stays within the 4,096 bytes ntfy publishes', async () => {
  await using d = await setup();
  for (let i = 0; i < 12; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- raised in order.
    await d.db.sql.begin((tx) =>
      raise(tx, {
        kind: 'service_down',
        now: new Date(at(0)),
        reason: `Unhealthy: ${'é'.repeat(2000)}.`,
        subject: `svc-${String(i).padStart(2, '0')}`,
        system: 'server-1',
      }),
    );
  }

  await d.pass(0.5);

  expect(new TextEncoder().encode(d.sent[0]?.message).length).toBeLessThanOrEqual(4096);
  expect(d.sent[0]?.message.split('\n').at(-1)).toBe('And 2 more.');
});

test('clipping cuts at whole characters and marks the cut', () => {
  expect(clipBytes('short', 10)).toBe('short');
  expect(clipBytes('ééééé', 7)).toBe('éé…');
});

test('two Hubs sharing a database send a push once', async () => {
  await using d = await setup();
  await d.down(0);
  const sent: Message[] = [];
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const slow = deliverAlerts(d.db.sql, {
    dashboard: DASHBOARD,
    now: at(0.5),
    send: async (message) => {
      await held;
      sent.push(message);
    },
  });
  // The second Hub's pass finds the first one's running and sends nothing.
  await Bun.sleep(100);
  await d.pass(0.5);
  release();
  await slow;
  await d.pass(1);

  expect([...sent, ...d.sent].map((m) => m.title)).toEqual(['Service down on server-1: nginx']);
});
