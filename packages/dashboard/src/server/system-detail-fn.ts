import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { parseDetailInput, parseSampleInput, readSample, readSystemPage } from './system-detail.ts';

// One System's detail over `range` (12h when none is given) with what its
// provisioner recorded and its Timeline, read at the server's clock. An unpaired
// System opens as it was left; not found for a name that is no System.
export const getSystemDetail = createServerFn({ method: 'GET' })
  .validator(parseDetailInput)
  .handler(async ({ data: { name, range } }) => {
    const sql = await database();
    const now = Date.now();
    const page = await readSystemPage(sql, { name, now, range });
    if (page === undefined) {
      throw notFound();
    }
    return page;
  });

// The sample of a System nearest `at`, or its newest, for the inspector;
// undefined when the System has none.
export const getSample = createServerFn({ method: 'GET' })
  .validator(parseSampleInput)
  .handler(async ({ data }) => (await readSample(await database(), data)) ?? null);
