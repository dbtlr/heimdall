import type { ConditionLevel } from '@heimdall/schema';
import type { ReactNode } from 'react';

import { LEVEL_FILL } from '../lib/conditions.ts';
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

function DiskRow({ disk, level }: { disk: Disk; level: ConditionLevel | undefined }) {
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
      <div
        aria-label={`${disk.mount} used`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="mt-0.5 h-1 overflow-hidden rounded-sm bg-[#2b3450]"
        role="meter"
      >
        <div
          className={cn('h-full', level === undefined ? 'bg-[#8fa7d6]' : LEVEL_FILL[level])}
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
// its load averages, the use of each disk, and its Harness installs. A fact the
// System never sent is left out, and so is the whole card when none was sent.
export function SystemFacts({
  detail,
}: {
  detail: Pick<SystemDetail, 'conditions' | 'harnesses' | 'latest' | 'now'>;
}) {
  const { harnesses, latest, now } = detail;
  if (latest === undefined && harnesses === undefined) {
    return null;
  }
  const asOf =
    latest !== undefined && now - latest.t > QUIET_AFTER_MS ? (
      <PhraseText phrase={[', as of ', whenAt(latest.t, now)]} />
    ) : undefined;
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
          <div className="max-h-[30dvh] overflow-y-auto">
            <ul>
              {latest.disks.map((disk, index) => (
                // A mount can be listed twice.
                // oxlint-disable-next-line react/no-array-index-key
                <DiskRow
                  disk={disk}
                  level={
                    detail.conditions.find(
                      (condition) =>
                        condition.kind === 'low_disk' &&
                        condition.subject === disk.mount &&
                        condition.clearedAt === undefined,
                    )?.level
                  }
                  key={`${disk.mount}-${String(index)}`}
                />
              ))}
            </ul>
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
