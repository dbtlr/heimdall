import { QUIET_AFTER_MS } from '../server/fleet-overview-types.ts';
import type {
  LoadBucket,
  MemoryBucket,
  MemoryHolders,
  ProcessSeries,
  SampleProcess,
  SessionRow,
  SystemDetail,
  UnlinkedSession,
} from '../server/system-detail-types.ts';
import { edgeSpans } from './bucket-edges.ts';
import { harnessName } from './lane.ts';
import { binMiddle } from './long-history.ts';
import { whenAt } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import { formatSpan, spanBox } from './time.ts';
import type { Window } from './time.ts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DAY_MS = 24 * 60 * 60_000;
const BUCKET_MS = 5 * 60_000;

const OS_NAMES: Record<string, string> = { darwin: 'macOS', linux: 'Linux' };

// Bytes in GiB to one decimal, without the unit.
export const formatGiB = (bytes: number): string => (bytes / GIB).toFixed(1);

const joinAnd = (words: readonly string[]) =>
  words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;

// The line under a System's name, as `lead` + `tail`: its platform, its
// Collector's version, how long it has been up while its Vitals are current,
// and when it last reported. Only a last Report a day or more old names a time,
// so only `tail` needs the viewer's zone. The full stop ends whichever part
// ends the sentence, so the lead shown before the zone is known has none astray.
export const headerLine = (
  detail: Pick<SystemDetail, 'collectorVersion' | 'lastSeenAt' | 'platform'> & {
    latest: { t: number; uptimeSeconds: number } | undefined;
  },
  now: number,
): { lead: string; tail: Phrase } => {
  if (detail.lastSeenAt === undefined) {
    return { lead: 'Never heard from.', tail: [] };
  }
  const facts: string[] = [];
  if (detail.platform !== undefined) {
    facts.push(`${OS_NAMES[detail.platform.os] ?? detail.platform.os} ${detail.platform.arch}`);
  }
  if (detail.collectorVersion !== undefined) {
    facts.push(`Collector ${detail.collectorVersion}`);
  }
  if (detail.latest !== undefined && now - detail.latest.t <= QUIET_AFTER_MS) {
    facts.push(`up ${formatSpan(detail.latest.uptimeSeconds * 1000)}`);
  }
  const ago = now - detail.lastSeenAt;
  if (ago < DAY_MS) {
    facts.push(`last Report ${formatSpan(ago)} ago`);
  }
  const joined = facts.join(', ');
  // Without a platform the sentence opens on "up" or "last Report".
  const lead =
    detail.platform === undefined ? `${joined.charAt(0).toUpperCase()}${joined.slice(1)}` : joined;
  if (ago < DAY_MS) {
    return { lead: `${lead}.`, tail: [] };
  }
  const report = joined === '' ? 'Last Report ' : ', last Report ';
  return { lead, tail: [report, whenAt(detail.lastSeenAt, now), '.'] };
};

// "heimdall on main", or whichever of the two a Session recorded.
const place = ({ branch, project }: { branch: string | undefined; project: string | undefined }) =>
  project !== undefined && branch !== undefined
    ? `${project} on ${branch}`
    : (project ?? branch ?? 'A Session');

const answered = (requests: number) =>
  requests === 0
    ? ''
    : ` ${String(requests)} ${requests === 1 ? 'request' : 'requests'} answered in this sample.`;

// A Harness process in the inspector: what it is and used, then the Sessions
// it ran and the requests it answered.
export const sampleProcessLine = (process: SampleProcess): { detail: string; title: string } => {
  const title = [
    `${harnessName(process.harness)} pid ${String(process.pid)}`,
    ...(process.cores === undefined ? [] : [`${process.cores.toFixed(1)} cores`]),
    ...(process.rssBytes === undefined ? [] : [`${formatGiB(process.rssBytes)} GiB`]),
  ].join(', ');
  let where = 'No Session linked.';
  if (process.sessions.length > 0) {
    where = `${joinAnd(process.sessions.map(place))}, linked.`;
  } else if (process.project !== undefined) {
    where = `In ${process.project}, no Session linked.`;
  }
  return { detail: `${where}${answered(process.requests)}`, title };
};

// A Session in the inspector that no single process is linked to, and why.
export const unlinkedLine = (session: UnlinkedSession): { detail: string; title: string } => {
  let why = 'unmatched: no process ran in its directory.';
  if (session.link === 'ambiguous') {
    why = `ambiguous: ${String(session.candidates)} processes share its directory.`;
  } else if (session.candidates > 0) {
    why = 'unmatched: one process may have run it, but the link is unconfirmed.';
  }
  return {
    detail: `${place(session)}, ${why}${answered(session.requests)}`,
    title: `${harnessName(session.harness)} Session`,
  };
};

// The processes holding the most memory at the sample taken `at`, largest
// first, each with its resident memory, which overlaps the others' and is never
// summed with them.
export type MemoryHoldersView = {
  at: number;
  rows: { name: string; pid: number; resident: string }[];
};

// Resident memory in GiB to one decimal, or in whole MiB below a GiB.
const residentMemory = (bytes: number) =>
  bytes >= GIB ? `${formatGiB(bytes)} GiB` : `${String(Math.round(bytes / MIB))} MiB`;

// The holders as the inspector and a high memory Condition show them;
// undefined when no list is named or the list is empty.
export const memoryHoldersView = (
  holders: MemoryHolders | undefined,
): MemoryHoldersView | undefined =>
  holders === undefined || holders.processes.length === 0
    ? undefined
    : {
        at: holders.t,
        rows: holders.processes.map(({ name, pid, rssBytes }) => ({
          name,
          pid,
          resident: residentMemory(rssBytes),
        })),
      };

// The start of every bucket the window touches, 5 minutes unless `bucketMs`
// says otherwise, aligned as the Hub aligns its rollups.
export const bucketGrid = ({ from, to }: Window, bucketMs = BUCKET_MS): number[] => {
  const starts: number[] = [];
  for (let t = Math.floor(from / bucketMs) * bucketMs; t < to; t += bucketMs) {
    starts.push(t);
  }
  return starts;
};

// Every bucket the window touches with its start and middle: `bucketMs` wide
// from the epoch, 5 minutes unless it says otherwise, or over a long range
// each bucket of `edges` (see LongEdges), local days or 3 hours of the local
// clock, so a 23- or 25-hour day is one bucket. A bucket the window cuts, the
// newest, has its middle at the middle of its part inside the window, so its
// point stays on the chart.
export const bucketSpans = (
  window: Window,
  bucketMs = BUCKET_MS,
  edges?: readonly number[],
): { middle: number; start: number }[] =>
  edges === undefined
    ? bucketGrid(window, bucketMs).map((start) => ({ middle: start + bucketMs / 2, start }))
    : edgeSpans(edges)
        .filter(({ end, start }) => end > window.from && start < window.to)
        .map(({ end, start }) => ({ middle: binMiddle({ end, t: start }, window), start }));

// The memory plot's points: GiB used per bucket at its middle, with the
// bucket's low to high, null where the Hub has no bucket, so the line breaks
// there. Buckets are as bucketSpans lays them.
export const memoryRows = (
  buckets: readonly MemoryBucket[],
  window: Window,
  bucketMs = BUCKET_MS,
  edges?: readonly number[],
): { band: [number, number] | null; t: number; used: number | null }[] => {
  const byStart = new Map(buckets.map((bucket) => [bucket.t, bucket]));
  return bucketSpans(window, bucketMs, edges).map(({ middle, start }) => {
    const bucket = byStart.get(start);
    return {
      band: bucket === undefined ? null : [bucket.lowBytes / GIB, bucket.highBytes / GIB],
      t: middle,
      used: bucket === undefined ? null : bucket.usedBytes / GIB,
    };
  });
};

// The load plot's points: the 1-minute load per bucket at its middle, with
// the bucket's low to high, null where the Hub has no bucket. Buckets are as
// bucketSpans lays them.
export const loadRows = (
  buckets: readonly LoadBucket[],
  window: Window,
  bucketMs = BUCKET_MS,
  edges?: readonly number[],
): { band: [number, number] | null; t: number; value: number | null }[] => {
  const byStart = new Map(buckets.map((bucket) => [bucket.t, bucket]));
  return bucketSpans(window, bucketMs, edges).map(({ middle, start }) => {
    const bucket = byStart.get(start);
    return {
      band: bucket === undefined ? null : [bucket.low, bucket.high],
      t: middle,
      value: bucket?.value ?? null,
    };
  });
};

// The process plot's points: each process's cores per bucket at its middle
// under the key `p<processId>`, null where it has none. Buckets are as
// bucketSpans lays them.
export const processRows = (
  processes: readonly ProcessSeries[],
  window: Window,
  bucketMs = BUCKET_MS,
  edges?: readonly number[],
): Record<string, number | null>[] => {
  const cores = processes.map(
    (process) =>
      [
        `p${String(process.processId)}`,
        new Map(process.points.map((point) => [point.t, point.cores])),
      ] as const,
  );
  return bucketSpans(window, bucketMs, edges).map(({ middle, start }) =>
    Object.fromEntries([
      ['t', middle],
      ...cores.map(([key, byBucket]) => [key, byBucket.get(start) ?? null] as const),
    ]),
  );
};

const isBusy = (process: ProcessSeries) =>
  process.points.some(({ cores }) => cores !== null && cores > 0);

// The Harness processes that kept a core busy in the window, and the idle rest,
// which the plots fold away.
export const splitIdleProcesses = (
  processes: readonly ProcessSeries[],
): { active: ProcessSeries[]; idle: ProcessSeries[] } => ({
  active: processes.filter((process) => isBusy(process)),
  idle: processes.filter((process) => !isBusy(process)),
});

// The disclosure that holds the idle processes' plot: "2 idle processes in this range".
export const idleProcessesLabel = (count: number): string =>
  `${String(count)} idle ${count === 1 ? 'process' : 'processes'} in this range`;

// The pinned time's big step on the time axis, in buckets: an hour of 5-minute ones.
const LARGE_STEP_BUCKETS = 12;

// The middle of the bucket `count` buckets of `edges` from the one holding
// `at`, among those the window touches, never past the first or last; undefined
// when no bucket holds `at`.
const bucketsAway = (
  edges: readonly number[],
  window: Window,
  at: number,
  count: number,
): number | undefined => {
  const spans = edgeSpans(edges).filter(({ end, start }) => end > window.from && start < window.to);
  const index = spans.findIndex(({ end, start }) => start <= at && at < end);
  const target = spans[Math.min(spans.length - 1, Math.max(0, index + count))];
  return index === -1 || target === undefined
    ? undefined
    : binMiddle({ end: target.end, t: target.start }, window);
};

// Where a key on the time axis moves the pinned time from `selected`, the
// newest time when none is pinned: a bucket, 5 minutes unless `bucketMs` says
// otherwise, for an arrow, 12 buckets (an hour of 5-minute ones) with Shift or
// for Page Up and Page Down, the window's ends for Home and End, and never past
// either end. Over a long range `edges` give the buckets, so a step lands on
// the adjacent bucket even when a clock change made the day 23 or 25 hours.
// Undefined for a key that moves nothing, and for any key held with Alt, Ctrl,
// or Meta, so the browser's own shortcuts still work.
export const steppedSample = (
  {
    altKey,
    ctrlKey,
    key,
    metaKey,
    shiftKey,
  }: { altKey: boolean; ctrlKey: boolean; key: string; metaKey: boolean; shiftKey: boolean },
  selected: number | undefined,
  { from, to }: Window,
  bucketMs = BUCKET_MS,
  edges?: readonly number[],
): number | undefined => {
  if (altKey || ctrlKey || metaKey) {
    return undefined;
  }
  const at = selected ?? to;
  const large = LARGE_STEP_BUCKETS * bucketMs;
  const step = shiftKey ? large : bucketMs;
  const buckets = shiftKey ? LARGE_STEP_BUCKETS : 1;
  const moved = (by: number, count: number) =>
    (edges === undefined ? undefined : bucketsAway(edges, { from, to }, at, count)) ??
    Math.min(to, Math.max(from, at + by));
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp': {
      return moved(step, buckets);
    }
    case 'ArrowLeft':
    case 'ArrowDown': {
      return moved(-step, -buckets);
    }
    case 'PageUp': {
      return moved(large, LARGE_STEP_BUCKETS);
    }
    case 'PageDown': {
      return moved(-large, -LARGE_STEP_BUCKETS);
    }
    case 'Home': {
      return from;
    }
    case 'End': {
      return to;
    }
    default: {
      return undefined;
    }
  }
};

// A label beside a Session's bars: after its last stretch, or before its
// first when the last ends too near the right edge to leave room, or over its
// first when neither side has room. In percent of the window from the left
// edge, or from the right edge for `right`.
export const costPlacement = (
  session: Pick<SessionRow, 'stretches'>,
  window: Window,
): { left: number } | { over: number } | { right: number } => {
  const first = session.stretches[0];
  const last = session.stretches.at(-1);
  if (first === undefined || last === undefined) {
    return { left: 0 };
  }
  const { left, width } = spanBox({ end: last.endedAt, start: first.startedAt }, window);
  if (left + width <= 85) {
    return { left: left + width };
  }
  return left >= 15 ? { right: 100 - left } : { over: left };
};
