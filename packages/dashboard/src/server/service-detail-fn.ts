import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { parseServiceDetailInput, readServiceDetail } from './service-detail.ts';

// One Service of one System with the stop it selects, read at the server's clock; not found for a System
// that does not exist, or a Service with neither a record nor a stop.
export const getServiceDetail = createServerFn({ method: 'GET' })
  .validator(parseServiceDetailInput)
  .handler(async ({ data: { name, service, stop } }) => {
    const detail = await readServiceDetail(await database(), {
      now: Date.now(),
      service,
      stop,
      system: name,
    });
    if (detail === undefined) {
      throw notFound();
    }
    return detail;
  });
