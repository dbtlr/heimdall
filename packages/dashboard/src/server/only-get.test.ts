import { expect, test } from 'bun:test';

import { Route as Health } from '../routes/api.health.ts';
import { Route as Records } from '../routes/api.v1.records.ts';
import { Route as ServiceStops } from '../routes/api.v1.service-stops.ts';

// TanStack Start renders the app's page, with 200, for a method a server route
// has no handler for, so each read route answers every other method itself.
test.each([
  ['/api/health', Health],
  ['/api/v1/records', Records],
  ['/api/v1/service-stops', ServiceStops],
])('%s answers a method other than GET with 405', async (_path, route) => {
  const any = route.options.server?.handlers;
  const handler = typeof any === 'object' ? any.ANY : undefined;
  expect(handler).toBeDefined();

  const response = await (handler as () => Response | Promise<Response>)();

  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toBe('GET, HEAD');
  expect(await response.text()).toBe('Only GET is answered here.');
});
