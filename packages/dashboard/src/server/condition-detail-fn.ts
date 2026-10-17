import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { parseConditionDetailInput, readConditionDetail } from './condition-detail.ts';
import { database } from './database.ts';

// One Condition occurrence of a System, opened, read at the server's clock; not
// found for an occurrence the System does not have.
export const getConditionDetail = createServerFn({ method: 'GET' })
  .validator(parseConditionDetailInput)
  .handler(async ({ data }) => {
    const detail = await readConditionDetail(await database(), { ...data, now: Date.now() });
    if (detail === undefined) {
      throw notFound();
    }
    return detail;
  });
