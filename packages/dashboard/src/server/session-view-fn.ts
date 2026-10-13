import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { parseSessionInput, readSessionView } from './session-view.ts';

// One agent Session with the Vitals of its System over its span, read in the
// server's time zone. Not found for a Session the Hub does not hold.
export const getSessionView = createServerFn({ method: 'GET' })
  .validator(parseSessionInput)
  .handler(async ({ data }) => {
    const view = await readSessionView(await database(), {
      ...data,
      timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (view === undefined) {
      throw notFound();
    }
    return view;
  });
