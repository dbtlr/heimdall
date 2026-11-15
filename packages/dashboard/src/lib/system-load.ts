import { isLongRange } from '../server/fleet-overview-types.ts';
import type { Range } from '../server/fleet-overview-types.ts';

// The System page and what its inspector reads first. Up to 7 d the two reads
// are independent and run together. Over 30 d and 1 y the inspector reads the
// bucket the page drew, so it waits for the page and takes the page's own
// edges: two clocks racing near local midnight could otherwise name a bucket
// outside the chart.
export const loadSystem = async <
  Page extends { detail: { edges: readonly number[] | undefined } },
  Inspected,
>({
  inspect,
  page,
  range,
}: {
  inspect: (edges: readonly number[] | undefined) => Promise<Inspected>;
  page: () => Promise<Page>;
  range: Range;
}): Promise<{ inspected: Inspected; page: Page }> => {
  if (!isLongRange(range)) {
    const [loaded, inspected] = await Promise.all([page(), inspect(undefined)]);
    return { inspected, page: loaded };
  }
  const loaded = await page();
  return { inspected: await inspect(loaded.detail.edges), page: loaded };
};
