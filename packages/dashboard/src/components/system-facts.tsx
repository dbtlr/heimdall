import type { ConditionLevel } from '@heimdall/schema';
import type { ReactNode } from 'react';

import { LEVEL_FILL } from '../lib/conditions.ts';
import { diskForecast, forecastWords } from '../lib/disk-forecast.ts';
import type { DiskBands } from '../lib/disk-forecast.ts';
import { diskUsage, formatLoad } from '../lib/facts.ts';
import { harnessName } from '../lib/lane.ts';
import { whenAt } from '../lib/phrase.ts';
import { cn } from '../lib/utils.ts';
import { QUIET_AFTER_MS } from '../server/fleet-overview-types.ts';
import type { Disk, HarnessInstall, SystemDetail } from '../server/system-detail-types.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { PhraseText } from './date-time.tsx';
import { MoreItems } from './more-items.tsx';

const LOAD_PERIODS = ['1 min', '5 min', '15 min'] as const;

// A column of the card: a heading, and the facts under it. `asOf` is the rest of
// the heading that dates facts from a sample that is no longer current.
function Fact({
  asOf,
  children,
  grow = 1,
  title,
}: {
  asOf?: ReactNode;
  children: ReactNode;
  grow?: number;
  title: string;
}) {
  return (
    <section
      className="min-w-0 sm:border-l sm:pl-[18px] sm:first:border-l-0 sm:first:pl-0"
      style={{ flexGrow: grow }}
    >
      <h2 className="mb-1.5 text-[12.5px] font-normal text-muted-foreground">
        {title}
        {asOf}
      </h2>
      {children}
    </section>
  );
}

// The rest of a heading that dates facts from a sample taken at `at`: ", as of
// <when>" once the sample is no longer current, else nothing.
function SampleAsOf({ at, now }: { at: number; now: number }) {
  return now - at > QUIET_AFTER_MS ? <PhraseText phrase={[', as of ', whenAt(at, now)]} /> : null;
}

type DiskDetail = Pick<SystemDetail, 'conditions' | 'diskTrends' | 'limitPercent'>;

// One mount: used of total with a tick at each band the Hub judges disks by,
// and under it how fast it grows and when it reaches the next band.
function DiskRow({
  bands,
  disk,
  forecast,
  level,
}: {
  bands: DiskBands | undefined;
  disk: Disk;
  forecast: string;
  level: ConditionLevel | undefined;
}) {
  const { percent, text } = diskUsage(disk);
  return (
    <li className="py-[3px]">
      <p className="flex items-baseline gap-2">
        <span className="font-semibold">{disk.mount}</span>
        <span className="min-w-0 flex-1 text-muted-foreground">{text}</span>
        <span
          className={cn(
            'text-[12.5px] text-muted-foreground',
            level !== undefined && MARK_COLOR[level],
          )}
        >
          {percent}%
        </span>
      </p>
      <div className="relative mt-0.5">
        <div
          aria-label={`${disk.mount} used`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="h-1 overflow-hidden rounded-sm bg-secondary"
          role="meter"
        >
          <div
            className={cn('h-full', level === undefined ? 'bg-plot' : LEVEL_FILL[level])}
            style={{ width: `${String(percent)}%` }}
          />
        </div>
        {bands !== undefined &&
          [bands.note, bands.warning, bands.alert].map((band) => (
            <span
              className="absolute -top-0.5 h-2 w-px bg-muted-foreground"
              data-band={band}
              key={band}
              style={{ left: `${String(band)}%` }}
              title={`${String(band)}%`}
            />
          ))}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{forecast}</p>
    </li>
  );
}

// Each mount of the newest sample as a row, with its open Low disk level, its
// growth over the last 7 days, and the next band it heads for.
function DiskRows({ detail, disks }: { detail: DiskDetail; disks: readonly Disk[] }) {
  const bands = detail.limitPercent?.disk;
  return (
    <ul>
      {disks.map((disk, index) => (
        // A mount can be listed twice.
        // oxlint-disable-next-line react/no-array-index-key
        <DiskRow
          bands={bands}
          disk={disk}
          forecast={forecastWords(
            diskForecast({
              bands,
              disk,
              growth: detail.diskTrends.find((trend) => trend.mount === disk.mount)?.growth,
            }),
          )}
          key={`${disk.mount}-${String(index)}`}
          level={
            detail.conditions.find(
              (condition) =>
                condition.kind === 'low_disk' &&
                condition.subject === disk.mount &&
                condition.clearedAt === undefined,
            )?.level
          }
        />
      ))}
    </ul>
  );
}

function Harnesses({ installs }: { installs: readonly HarnessInstall[] }) {
  if (installs.length === 0) {
    return <p className="text-muted-foreground">None installed</p>;
  }
  return (
    <ul>
      {installs.map(({ harness, location, version }, index) => (
        // One Harness can have several installs at one version.
        // oxlint-disable-next-line react/no-array-index-key
        <li className="py-0.5" key={`${harness}-${location}-${version}-${String(index)}`}>
          <b className="font-semibold">
            {harnessName(harness)} {version}
          </b>
          <span className="block text-muted-foreground">{location}</span>
        </li>
      ))}
    </ul>
  );
}

// What the Collector last said about the System that the plots do not draw:
// its load averages, the use and growth of each disk, and its Harness
// installs. A fact the System never sent is left out, and so is the whole card
// when none was sent.
export function SystemFacts({
  detail,
}: {
  detail: DiskDetail & Pick<SystemDetail, 'harnesses' | 'latest' | 'now'>;
}) {
  const { harnesses, latest, now } = detail;
  if (latest === undefined && harnesses === undefined) {
    return null;
  }
  const asOf = latest === undefined ? undefined : <SampleAsOf at={latest.t} now={now} />;
  return (
    <section
      aria-label="System facts"
      className="mt-1 mb-2.5 flex flex-col gap-4 card-surface rounded-xl border px-4 py-3.5 sm:flex-row"
    >
      {latest !== undefined && (
        <Fact asOf={asOf} title="Load average">
          <div className="flex gap-[18px]">
            {latest.load.map((load, i) => (
              <div key={LOAD_PERIODS[i]}>
                <span className="block text-[19px] leading-tight font-semibold tabular-nums">
                  {formatLoad(load)}
                </span>
                <span className="block text-xs text-muted-foreground">{LOAD_PERIODS[i]}</span>
              </div>
            ))}
          </div>
        </Fact>
      )}
      {latest !== undefined && (
        <Fact asOf={asOf} grow={1.5} title="Disks">
          <div className="max-h-[30dvh] overflow-y-auto">
            <DiskRows detail={detail} disks={latest.disks} />
          </div>
        </Fact>
      )}
      {harnesses !== undefined && (
        <Fact title="Harnesses installed">
          {harnesses.length > 3 ? (
            <MoreItems label={`Show ${String(harnesses.length)} Harness installs`}>
              <Harnesses installs={harnesses} />
            </MoreItems>
          ) : (
            <Harnesses installs={harnesses} />
          )}
        </Fact>
      )}
    </section>
  );
}

const WIDE_CARD = 'min-w-0 card-surface rounded-xl border px-4 py-3.5';

const WIDE_HEADING = 'mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-dim uppercase';

// The card of each disk's use, under the charts on a wide screen: used of
// total with a tick at each band the Hub judges disks by, the Low disk level
// when one is open on it, and its growth over 7 days with the next band it
// reaches, dated as the System facts are when the sample is no longer current.
// Nothing without a sample.
export function SystemDisks({
  detail,
}: {
  detail: DiskDetail & Pick<SystemDetail, 'latest' | 'now'>;
}) {
  const { latest, now } = detail;
  if (latest === undefined) {
    return null;
  }
  return (
    <section aria-label="Disks" className={WIDE_CARD}>
      <h2 className={WIDE_HEADING}>
        Disks
        <SampleAsOf at={latest.t} now={now} />{' '}
        <span className="font-normal tracking-normal normal-case">growth over 7 days</span>
      </h2>
      {latest.disks.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">The Collector reported no disk.</p>
      ) : (
        <DiskRows detail={detail} disks={latest.disks} />
      )}
    </section>
  );
}

// The card of installed Harnesses, under the charts on a wide screen. Nothing
// for a Collector that never said.
export function SystemHarnesses({
  harnesses,
}: {
  harnesses: readonly HarnessInstall[] | undefined;
}) {
  if (harnesses === undefined) {
    return null;
  }
  return (
    <section aria-label="Harnesses installed" className={WIDE_CARD}>
      <h2 className={WIDE_HEADING}>Harnesses installed</h2>
      <Harnesses installs={harnesses} />
    </section>
  );
}
