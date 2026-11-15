// The Collector names the holders at most once a minute; two minutes also
// covers one sample missed by a failed process read. Mirrors the dashboard's
// rule for the sample inspector.
export const CARRIER_MAX_AGE_MS = 2 * 60_000;
// Keeps Activity's one-line reason readable when a process has a very long name.
const MAX_NAME_CHARS = 30;
const GIB = 2 ** 30;
const MIB = 2 ** 20;

export type MemoryHolder = { name: string; rssBytes: number };

type Carrier = {
  t: Date;
  top_by_memory?: readonly MemoryHolder[] | null;
  uptime_seconds: number;
};

// The holders for the sample at `index` of `rows` (ordered by time): the
// newest sample at or before it carrying a list, at most two minutes older and
// from the same boot. That sample decides: an empty list means no holders, as
// on the dashboard. Empty when there is none.
export const holdersAt = (rows: readonly Carrier[], index: number): MemoryHolder[] => {
  const row = rows[index];
  if (row === undefined) {
    return [];
  }
  const at = row.t.getTime();
  const from = Math.max(at - CARRIER_MAX_AGE_MS, at - row.uptime_seconds * 1000);
  for (let i = index; i >= 0; i -= 1) {
    const candidate = rows[i];
    if (candidate === undefined || candidate.t.getTime() < from) {
      break;
    }
    if (candidate.top_by_memory != null) {
      return [...candidate.top_by_memory];
    }
  }
  return [];
};

const sizeText = (bytes: number) =>
  bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GiB` : `${String(Math.round(bytes / MIB))} MiB`;

// Cuts by code point so an emoji is never split.
const nameText = (name: string) => {
  let kept = 0;
  let count = 0;
  for (const point of name) {
    if (count < MAX_NAME_CHARS - 1) {
      kept += point.length;
    }
    count += 1;
  }
  return count > MAX_NAME_CHARS ? `${name.slice(0, kept)}…` : name;
};

// `postgres 3.1 GiB, node 1.2 GiB`, largest first; empty for no holders.
export const holdersText = (holders: readonly MemoryHolder[]) =>
  holders
    .toSorted((a, b) => b.rssBytes - a.rssBytes)
    .map(({ name, rssBytes }) => `${nameText(name)} ${sizeText(rssBytes)}`)
    .join(', ');
