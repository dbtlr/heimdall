import type { ReactNode } from 'react';

import { diskUsage, formatLoad } from '../lib/facts.ts';
import { harnessName } from '../lib/lane.ts';
import { formatWhen } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import { QUIET_AFTER_MS } from '../server/fleet-overview-types.ts';
import type { Disk, HarnessInstall, SystemDetail } from '../server/system-detail-types.ts';

const LOAD_PERIODS = ['1 min', '5 min', '15 min'] as const;

// A column of the card: a heading, and the facts under it. `asOf` dates facts
// from a sample that is no longer current.
function Fact({
  asOf,
  children,
  grow = 1,
  title,
}: {
  asOf?: string | undefined;
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
        {asOf === undefined ? '' : `, as of ${asOf}`}
      </h2>
      {children}
    </section>
  );
}

function DiskRow({ disk }: { disk: Disk }) {
  const { nearlyFull, percent, text } = diskUsage(disk);
  return (
    <li className="py-[3px]">
      <p className="flex items-baseline gap-2">
        <span className="font-semibold">{disk.mount}</span>
        <span className="min-w-0 flex-1 text-muted-foreground">{text}</span>
        <span
          className={cn(
            'text-[12.5px] text-muted-foreground',
            nearlyFull && 'text-[color-mix(in_srgb,var(--status-serious)_70%,white)]',
          )}
        >
          {percent}%
        </span>
      </p>
      <div
        aria-label={`${disk.mount} used`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="mt-0.5 h-1 overflow-hidden rounded-sm bg-[#2b3450]"
        role="meter"
      >
        <div
          className={cn('h-full', nearlyFull ? 'bg-status-serious' : 'bg-[#8fa7d6]')}
          style={{ width: `${String(percent)}%` }}
        />
      </div>
    </li>
  );
}

function Harnesses({ installs }: { installs: readonly HarnessInstall[] }) {
  if (installs.length === 0) {
    return <p className="text-muted-foreground">None installed</p>;
  }
  return (
    <ul>
      {installs.map(({ harness, location, version }) => (
        <li className="py-0.5" key={`${harness}-${location}-${version}`}>
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
// its load averages, the use of each disk, and its Harness installs. A fact the
// System never sent is left out, and so is the whole card when none was sent.
export function SystemFacts({
  detail,
  timeZone,
}: {
  detail: Pick<SystemDetail, 'harnesses' | 'latest' | 'now'>;
  timeZone: string;
}) {
  const { harnesses, latest, now } = detail;
  if (latest === undefined && harnesses === undefined) {
    return null;
  }
  const asOf =
    latest !== undefined && now - latest.t > QUIET_AFTER_MS
      ? formatWhen(latest.t, now, timeZone)
      : undefined;
  return (
    <section
      aria-label="System facts"
      className="mt-1 mb-2.5 flex flex-col gap-4 rounded-lg bg-card px-4 py-3.5 sm:flex-row"
    >
      {latest !== undefined && (
        <Fact asOf={asOf} title="Load average">
          <div className="flex gap-[18px]">
            {latest.load.map((load, i) => (
              <div key={LOAD_PERIODS[i]}>
                <span className="block text-[19px] leading-tight font-semibold">
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
          <ul>
            {latest.disks.map((disk) => (
              <DiskRow disk={disk} key={disk.mount} />
            ))}
          </ul>
        </Fact>
      )}
      {harnesses !== undefined && (
        <Fact title="Harnesses installed">
          <Harnesses installs={harnesses} />
        </Fact>
      )}
    </section>
  );
}
