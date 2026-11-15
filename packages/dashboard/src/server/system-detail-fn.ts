import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import {
  parseBucketInput,
  parseDetailInput,
  parseSampleInput,
  readBucket,
  readSample,
  readSystemPage,
} from './system-detail.ts';

// One System's detail over `range` (12h when none is given) with what its
// provisioner recorded and its Activity, read at the server's clock, its long
// ranges' days in `timeZone`, else UTC's. An unpaired System opens as it was
// left; not found for a name that is no System.
export const getSystemDetail = createServerFn({ method: 'GET' })
  .validator(parseDetailInput)
  .handler(async ({ data: { name, range, timeZone } }) => {
    const sql = await database();
    const now = Date.now();
    const page = await readSystemPage(sql, { name, now, range, timeZone });
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

// The bucket of a long range holding `at`, or the newest, for the inspector,
// read at the server's clock in `timeZone`, else UTC, or exactly the `span` the
// page drew; undefined when the name is no System.
export const getBucket = createServerFn({ method: 'GET' })
  .validator(parseBucketInput)
  .handler(
    async ({ data }) => (await readBucket(await database(), { ...data, now: Date.now() })) ?? null,
  );
