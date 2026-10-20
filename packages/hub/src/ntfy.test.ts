import { expect, test } from 'bun:test';

import { clear, raise } from './conditions.ts';
import { parseDeliveryChannel } from './delivery-config.ts';
import { deliverAlerts } from './delivery.ts';
import { ntfySender } from './ntfy.ts';
import { failure, migrate, NOW, storeToken } from './testing/hub.ts';
import { testDatabase } from './testing/postgres.ts';

type Received = { authorization: string | null; body: unknown; path: string };

// A stand-in ntfy server that records each publish and answers `status`.
const stubNtfy = (status = 200) => {
  const received: Received[] = [];
  const server = Bun.serve({
    fetch: async (request) => {
      received.push({
        authorization: request.headers.get('authorization'),
        body: await request.json(),
        path: new URL(request.url).pathname,
      });
      return Response.json({ id: 'x' }, { status });
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  return { received, server, [Symbol.dispose]: () => void server.stop(true) };
};

const channel = (server: { url: URL }, token?: string) => {
  const parsed = parseDeliveryChannel({
    dashboard: 'https://dashboard.example/',
    token,
    topic: 'heimdall-x7Qp',
    url: server.url.href,
  });
  if (parsed === undefined) {
    throw new Error('A channel was expected.');
  }
  return parsed;
};

test('a push publishes JSON to the server with the topic in the body and the token as a bearer', async () => {
  using ntfy = stubNtfy();

  await ntfySender(channel(ntfy.server, 'tk_s3cret'))({
    click: 'https://dashboard.example/systems/server-1/conditions/7',
    message: 'nginx: inactive (dead). At alert for under a minute.',
    priority: 'high',
    title: 'Service down on server-1: nginx',
  });

  expect(ntfy.received).toEqual([
    {
      authorization: 'Bearer tk_s3cret',
      body: {
        click: 'https://dashboard.example/systems/server-1/conditions/7',
        message: 'nginx: inactive (dead). At alert for under a minute.',
        priority: 4,
        tags: ['rotating_light'],
        title: 'Service down on server-1: nginx',
        topic: 'heimdall-x7Qp',
      },
      path: '/',
    },
  ]);
});

test('a refused publish throws with its status and never the topic or token', async () => {
  using ntfy = stubNtfy(403);

  const sent = ntfySender(channel(ntfy.server, 'tk_s3cret'))({
    click: 'https://dashboard.example/',
    message: 'Cleared. Reached alert once.',
    priority: 'low',
    title: 'Recovered: Service down on server-1: nginx',
  });

  const message = String(await failure(sent));
  expect(message).toContain('The ntfy server answered 403.');
  expect(message).not.toContain('heimdall-x7Qp');
  expect(message).not.toContain('tk_s3cret');
});

test('a Condition at alert reaches ntfy as one push, then one recovered message 10 minutes after it clears', async () => {
  using ntfy = stubNtfy();
  await using db = await testDatabase();
  await migrate(db.sql);
  await storeToken(db.sql, { pairedAt: NOW, system: 'server-1', token: 'server-token' });
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('server-1', now())`;
  const send = ntfySender(channel(ntfy.server));
  const pass = (minutes: number) =>
    deliverAlerts(db.sql, {
      dashboard: new URL('https://dashboard.example/'),
      now: NOW + minutes * 60_000,
      send,
    });
  const service = { kind: 'service_down', subject: 'nginx', system: 'server-1' } as const;

  await db.sql.begin((tx) =>
    raise(tx, { ...service, now: new Date(NOW), reason: 'nginx: inactive (dead).' }),
  );
  await pass(0.5);
  await pass(1);
  await db.sql.begin((tx) => clear(tx, { ...service, now: new Date(NOW + 2 * 60_000) }));
  await pass(11);
  await pass(12);
  await pass(30);

  expect(ntfy.received.map((r) => r.body as { priority: number; title: string })).toEqual(
    [
      { priority: 4, title: 'Service down on server-1: nginx' },
      { priority: 2, title: 'Recovered: Service down on server-1: nginx' },
    ].map((expected) => expect.objectContaining(expected)),
  );
});
