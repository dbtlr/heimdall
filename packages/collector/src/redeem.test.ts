import { expect, test } from 'bun:test';

import { redeemCode } from './redeem.ts';
import { fakeHub, stalledBody } from './testing/fake-hub.ts';

test('an answer whose body stalls past the timeout is a dropped connection, not a malformed answer', async () => {
  await using hub = fakeHub(
    () =>
      new Response(stalledBody('{"system":"desktop-1",'), {
        headers: { 'content-type': 'application/json' },
      }),
  );

  const outcome = await redeemCode({ code: '7K3M-Q9XA', hub: new URL(hub.url), timeoutMs: 200 });

  expect(outcome.kind).toBe('dropped');
});

test('an answer streamed past 4 KiB is too large, however it is sent', async () => {
  await using hub = fakeHub(
    () =>
      new Response(
        new ReadableStream({
          pull: (controller) => controller.enqueue(new TextEncoder().encode(' '.repeat(1024))),
        }),
      ),
  );

  const outcome = await redeemCode({ code: '7K3M-Q9XA', hub: new URL(hub.url), timeoutMs: 5000 });

  expect(outcome).toEqual({ kind: 'oversized' });
});
