import { QUIET_AFTER_MS } from '../server/fleet-overview-types.ts';
import type {
  MemoryBucket,
  ProcessSeries,
  SampleProcess,
  SessionRow,
  SystemDetail,
  TimelineEntry,
  UnlinkedSession,
} from '../server/system-detail-types.ts';
import { harnessName } from './lane.ts';
import { formatSpan, formatWhen, spanBox } from './time.ts';
import type { Window } from './time.ts';

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60_000;
const BUCKET_MS = 5 * 60_000;

type At = { now: number; timeZone: string };

const OS_NAMES: Record<string, string> = { darwin: 'macOS', linux: 'Linux' };

// Bytes in GiB to one decimal, without the unit.
export const formatGiB = (bytes: number): string => (bytes / GIB).toFixed(1);

const joinAnd = (words: readonly string[]) =>
  words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;

// The line under a System's name: its platform, how long it has been up while
// its Vitals are current, when it last reported, and its installed Harnesses.
export const headerLine = (
  detail: Pick<SystemDetail, 'harnesses' | 'lastSeenAt' | 'platform'> & {
    latest: { t: number; uptimeSeconds: number } | undefined;
  },
  { now, timeZone }: At,
): string => {
  if (detail.lastSeenAt === undefined) {
    return 'Never heard from.';
  }
  const facts: string[] = [];
  if (detail.platform !== undefined) {
    facts.push(`${OS_NAMES[detail.platform.os] ?? detail.platform.os} ${detail.platform.arch}`);
  }
  if (detail.latest !== undefined && now - detail.latest.t <= QUIET_AFTER_MS) {
    facts.push(`up ${formatSpan(detail.latest.uptimeSeconds * 1000)}`);
  }
  const ago = now - detail.lastSeenAt;
  facts.push(
    `last Report ${ago < DAY_MS ? `${formatSpan(ago)} ago` : formatWhen(detail.lastSeenAt, now, timeZone)}`,
  );
  const harnesses = detail.harnesses.map(
    ({ harness, version }) => `${harnessName(harness)} ${version}`,
  );
  const joined = facts.join(', ');
  // Without a platform the sentence opens on "up" or "last Report".
  const first =
    detail.platform === undefined ? `${joined.charAt(0).toUpperCase()}${joined.slice(1)}` : joined;
  return harnesses.length === 0 ? `${first}.` : `${first}. ${joinAnd(harnesses)}.`;
};

// When a Condition on the Timeline was raised and cleared, and for how long.
export const timelineWhen = (
  entry: Pick<TimelineEntry, 'clearedAt' | 'raisedAt'>,
  { now, timeZone }: At,
): string =>
  entry.clearedAt === undefined
    ? `Open since ${formatWhen(entry.raisedAt, now, timeZone)}, ${formatSpan(now - entry.raisedAt)}`
    : `${formatWhen(entry.raisedAt, now, timeZone)} to ${formatWhen(entry.clearedAt, now, timeZone)}, ${formatSpan(entry.clearedAt - entry.raisedAt)}`;

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

// The start of every bucket the window touches, 5 minutes unless `bucketMs`
// says otherwise, aligned as the Hub aligns its rollups.
export const bucketGrid = ({ from, to }: Window, bucketMs = BUCKET_MS): number[] => {
  const starts: number[] = [];
  for (let t = Math.floor(from / bucketMs) * bucketMs; t < to; t += bucketMs) {
    starts.push(t);
  }
  return starts;
};

// The memory plot's points: GiB used per bucket at its middle, null where the
// Hub has no bucket, so the line breaks there.
export const memoryRows = (
  buckets: readonly MemoryBucket[],
  window: Window,
): { t: number; used: number | null }[] => {
  const used = new Map(buckets.map((bucket) => [bucket.t, bucket.usedBytes / GIB]));
  return bucketGrid(window).map((t) => ({ t: t + BUCKET_MS / 2, used: used.get(t) ?? null }));
};

// The process plot's points: each process's cores per bucket at its middle
// under the key `p<processId>`, null where it has none.
export const processRows = (
  processes: readonly ProcessSeries[],
  window: Window,
  bucketMs = BUCKET_MS,
): Record<string, number | null>[] => {
  const cores = processes.map(
    (process) =>
      [
        `p${String(process.processId)}`,
        new Map(process.points.map((point) => [point.t, point.cores])),
      ] as const,
  );
  return bucketGrid(window, bucketMs).map((t) =>
    Object.fromEntries([
      ['t', t + bucketMs / 2],
      ...cores.map(([key, byBucket]) => [key, byBucket.get(t) ?? null] as const),
    ]),
  );
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
