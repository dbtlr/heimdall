import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { parseSessionInput, readSessionView } from './session-view.ts';

// One agent Session with the Vitals of its System over its span. Not found for a
// Session the Hub does not hold.
export const getSessionView = createServerFn({ method: 'GET' })
  .validator(parseSessionInput)
  .handler(async ({ data }) => {
    const view = await readSessionView(await database(), data);
    if (view === undefined) {
      throw notFound();
    }
    return view;
  });
