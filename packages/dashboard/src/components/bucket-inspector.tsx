import { CONDITION_KIND_NAMES, conditionSubject } from '@heimdall/schema';
import type { ReactNode } from 'react';

import { LEVEL_FILL } from '../lib/conditions.ts';
import { formatGiB } from '../lib/detail.ts';
import { harnessColor, harnessName } from '../lib/lane.ts';
import { formatClock, formatCost, formatDate, formatDateYear, formatWeekday } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { BucketInspection, BucketProcess } from '../server/system-detail-types.ts';
import { InZone } from './date-time.tsx';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

const percent = (value: number) => `${String(Math.round(value))}%`;

// A bucket's width in words: "1-day" or "3-hour".
const widthWords = (bucketMs: number): string =>
  bucketMs >= DAY_MS
    ? `${String(bucketMs / DAY_MS)}-day`
    : `${String(Math.round(bucketMs / HOUR_MS))}-hour`;

// What the bucket is called in a sentence: "that day" or "in the bucket".
const bucketPlace = (bucketMs: number): string => (bucketMs >= DAY_MS ? 'that day' : 'then');

const resident = (bytes: number): string =>
  bytes >= GIB ? `${formatGiB(bytes)} GiB` : `${String(Math.round(bytes / MIB))} MiB`;

const plural = (count: number, one: string) => `${String(count)} ${one}${count === 1 ? '' : 's'}`;

// A Harness process's line: its CPU time and peak in the bucket, and its
// Sessions.
const processDetail = (process: BucketProcess): string => {
  const usage = [
    ...(process.cpuHours === undefined ? [] : [`${process.cpuHours.toFixed(1)} CPU-hours`]),
    ...(process.peakRssBytes === undefined ? [] : [`peak ${resident(process.peakRssBytes)}`]),
  ].join(', ');
  return [usage, plural(process.sessions, 'Session')].filter((part) => part !== '').join(' · ');
};

function Heading({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3.5 mb-2 text-[11px] font-semibold tracking-[0.08em] text-dim uppercase">
      {children}
    </p>
  );
}

// The day a bucket starts on in `timeZone`, as "Wed 12 Aug 2026", or for a
// bucket shorter than a day, which is within the last 30, its day and clock
// span, as "Tue 3 Nov 15:00–18:00".
const bucketDay = (t: number, bucketMs: number, timeZone: string): string => {
  const weekday = formatWeekday(t, timeZone);
  return bucketMs < DAY_MS
    ? `${weekday} ${formatDate(t, timeZone)} ${formatClock(t, timeZone)}–${formatClock(t + bucketMs, timeZone)}`
    : `${weekday} ${formatDateYear(t, timeZone)}`;
};

// Where a day bucket starts, " from 01:00", when the viewer's zone does not
// start its days where the Hub's UTC days start.
const dayStart = (t: number, bucketMs: number, timeZone: string): string => {
  const start = formatClock(t, timeZone);
  return bucketMs < DAY_MS || start === '00:00' ? '' : ` from ${start}`;
};

// The panel that inspects one bucket of a long range: its CPU, memory, and
// load averages with their lows and highs from the 5-minute rollups in it, a
// reboot in it, its agent cost and Sessions, the Harness processes that ran
// then, and the Conditions open then. Past the 14 days raw samples are kept,
// it says the top processes and memory holders are gone with them.
export function BucketInspector({
  bucket,
  failed,
  loading = false,
}: {
  bucket: BucketInspection | null;
  failed: boolean;
  loading?: boolean;
}) {
  const place = bucket === null ? '' : bucketPlace(bucket.bucketMs);
  return (
    <aside
      aria-busy={loading}
      className="max-h-[70dvh] self-start overflow-y-auto card-surface rounded-xl border-l-[3px] border-l-select px-4 py-3.5"
    >
      {loading && <p role="status">Reading bucket…</p>}
      {bucket === null && !loading && (
        <p className="text-muted-foreground">
          {failed
            ? 'The bucket could not be read. Select a time to try again.'
            : 'No bucket to inspect.'}
        </p>
      )}
      {bucket !== null && (
        <>
          <p className="flex items-baseline gap-2">
            <b className="text-[17px] font-semibold tabular-nums">
              <InZone>{(timeZone) => bucketDay(bucket.t, bucket.bucketMs, timeZone)}</InZone>
            </b>
            <span className="text-[12.5px] text-muted-foreground">
              pinned {bucket.bucketMs >= DAY_MS ? 'day' : 'bucket'}
            </span>
          </p>
          <p className="mb-2 text-[11.5px] text-dim">
            One {widthWords(bucket.bucketMs)} bucket
            <InZone>{(timeZone) => dayStart(bucket.t, bucket.bucketMs, timeZone)}</InZone>:{' '}
            {bucket.rollups === 0 ? 'no Vitals' : `${String(bucket.rollups)} five-minute rollups`}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13.5px]">
            {bucket.cpu !== undefined && (
              <>
                <dt className="text-muted-foreground">CPU busy</dt>
                <dd>
                  <b className="font-semibold">avg {percent(bucket.cpu.average)}</b>
                  <span className="block text-xs text-muted-foreground">
                    low {Math.round(bucket.cpu.low)}, high {Math.round(bucket.cpu.high)}
                  </span>
                </dd>
              </>
            )}
            {bucket.memory !== undefined && (
              <>
                <dt className="text-muted-foreground">Memory</dt>
                <dd>
                  <b className="font-semibold">
                    avg {formatGiB(bucket.memory.average)} / {formatGiB(bucket.memory.totalBytes)}{' '}
                    GiB
                  </b>
                  <span className="block text-xs text-muted-foreground">
                    high {formatGiB(bucket.memory.high)} GiB
                  </span>
                </dd>
              </>
            )}
            {bucket.load1 !== undefined && (
              <>
                <dt className="text-muted-foreground">Load (1 min)</dt>
                <dd>
                  <b className="font-semibold">avg {bucket.load1.average.toFixed(1)}</b>
                  <span className="block text-xs text-muted-foreground">
                    high {bucket.load1.high.toFixed(1)}
                  </span>
                </dd>
              </>
            )}
            {bucket.rebootedAt !== undefined && (
              <>
                <dt className="text-muted-foreground">Uptime</dt>
                <dd>
                  <b className="font-semibold">
                    Rebooted{' '}
                    <InZone>{(timeZone) => formatClock(bucket.rebootedAt ?? 0, timeZone)}</InZone>
                  </b>
                  <span className="block text-xs text-muted-foreground">
                    smallest uptime in a 5-minute rollup
                  </span>
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Agent cost</dt>
            <dd>
              <b className="font-semibold">
                {bucket.unpricedRequests > 0 && 'at least '}
                {formatCost(bucket.costUsd)}
              </b>
              <span className="block text-xs text-muted-foreground">
                {plural(bucket.sessions, 'Session')} working {place}
              </span>
            </dd>
          </dl>
          <Heading>Harness processes {place}</Heading>
          {bucket.processes.length === 0 ? (
            <p className="text-[13.5px] text-muted-foreground">No Harness process.</p>
          ) : (
            <ul>
              {bucket.processes.map((process) => (
                <li
                  className="flex items-start gap-2 py-[5px] text-[13.5px]"
                  key={process.processId}
                >
                  <i
                    className="mt-[5px] inline-block h-2 w-3.5 flex-none rounded-[2px] bg-current"
                    style={{ color: harnessColor(process.harness) }}
                  />
                  <span>
                    <b className="font-semibold">
                      {process.project ?? harnessName(process.harness)}
                    </b>{' '}
                    · pid {process.pid}
                    <br />
                    <span className="text-xs text-muted-foreground">{processDetail(process)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {bucket.conditions.length > 0 && (
            <>
              <Heading>Conditions open {place}</Heading>
              <ul className="text-[13.5px]">
                {bucket.conditions.map((condition, index) => (
                  <li
                    className="flex items-baseline gap-2 py-0.5"
                    // Two Conditions may share a kind and subject over a bucket.
                    // oxlint-disable-next-line react/no-array-index-key
                    key={`${condition.kind}-${condition.subject}-${String(index)}`}
                  >
                    <i
                      className={cn(
                        'inline-block size-2 flex-none rounded-[2px]',
                        LEVEL_FILL[condition.level],
                      )}
                    />
                    <span>
                      {CONDITION_KIND_NAMES[condition.kind]}
                      {condition.subject !== '' && ` · ${conditionSubject(condition)}`}{' '}
                      <span className="text-muted-foreground">{condition.level}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {bucket.samplesPruned && (
            <p className="mt-3.5 text-xs text-muted-foreground">
              Top CPU processes and memory holders{' '}
              <span className="inline-block rounded-sm border border-dashed border-status-serious px-1 whitespace-nowrap text-status-serious">
                not kept past 14 d
              </span>
            </p>
          )}
        </>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Select any point on the axis to inspect its bucket.
      </p>
    </aside>
  );
}
