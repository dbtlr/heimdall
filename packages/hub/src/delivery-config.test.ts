import { expect, test } from 'bun:test';

import { parseDeliveryChannel } from './delivery-config.ts';

const valid = {
  dashboard: 'https://dashboard.example/heimdall',
  token: 'tk_s3cret',
  topic: 'heimdall-x7Qp',
  url: 'https://ntfy.example',
};

test('without a [delivery] section, delivery is off', () => {
  expect(parseDeliveryChannel(undefined)).toBeUndefined();
});

test('a [delivery] section names the server, topic, optional token, and dashboard', () => {
  const channel = parseDeliveryChannel(valid);
  expect(channel?.url.href).toBe('https://ntfy.example/');
  expect(channel?.topic).toBe('heimdall-x7Qp');
  expect(channel?.token).toBe('tk_s3cret');
  // Links resolve below the dashboard's path.
  expect(channel?.dashboard.href).toBe('https://dashboard.example/heimdall/');
  expect(parseDeliveryChannel({ ...valid, token: undefined })?.token).toBeUndefined();
});

test.each([
  ['a missing dashboard', { ...valid, dashboard: undefined }, 'delivery.dashboard'],
  ['a missing topic', { ...valid, topic: undefined }, 'delivery.topic'],
  ['a server that is not http', { ...valid, url: 'ftp://ntfy.example' }, 'delivery.url'],
  ['a topic ntfy refuses', { ...valid, topic: 'has space' }, 'delivery.topic'],
  ['an empty token', { ...valid, token: '' }, 'delivery.token'],
  ['an unknown setting', { ...valid, priority: 'high' }, 'delivery.priority'],
  ['a value that is not a table', 'https://ntfy.example', 'delivery: expected a table'],
])('%s is refused, naming the setting and never a secret', (_, section, setting) => {
  let message = '';
  try {
    parseDeliveryChannel(section);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain(setting);
  expect(message).not.toContain('heimdall-x7Qp');
  expect(message).not.toContain('tk_s3cret');
  expect(message).not.toContain('has space');
});
