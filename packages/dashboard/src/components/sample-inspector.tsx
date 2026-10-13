import { formatGiB, sampleProcessLine, unlinkedLine } from '../lib/detail.ts';
import { harnessColor } from '../lib/lane.ts';
import { formatClock } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { SampleInspection } from '../server/system-detail-types.ts';

const percent = (value: number) => `${String(Math.round(value))}%`;

const clockWithSeconds = (t: number, timeZone: string) =>
  `${formatClock(t, timeZone)}:${new Intl.DateTimeFormat('en-GB', { second: '2-digit', timeZone })
    .format(t)
    .padStart(2, '0')}`;

function Entry({
  color,
  dashed,
  detail,
  title,
}: {
  color: string;
  dashed: boolean;
  detail: string;
  title: string;
}) {
  return (
    <li className="flex items-start gap-2 py-[5px] text-[13.5px]">
      <i
        className={cn(
          'mt-[5px] inline-block h-2 w-3.5 flex-none rounded-[2px]',
          dashed
            ? 'border-[1.5px] border-dashed border-current bg-[color-mix(in_srgb,currentColor_30%,transparent)]'
            : 'bg-current',
        )}
        style={{ color }}
      />
      <span>
        <b className="font-semibold">{title}</b>
        <br />
        <span className="text-muted-foreground">{detail}</span>
      </span>
    </li>
  );
}

// The panel that inspects one Vitals sample: its CPU against its 5-minute
// bucket, memory and load, the Harness processes running then with their
// Sessions, and the Sessions no single process is linked to.
export function SampleInspector({
  sample,
  timeZone,
}: {
  sample: SampleInspection | null;
  timeZone: string;
}) {
  return (
    <aside className="mt-2.5 self-start rounded-lg border-l-[3px] border-l-[#ffd666] bg-card px-4 py-3.5">
      {sample === null ? (
        <p className="text-muted-foreground">No Vitals sample to inspect.</p>
      ) : (
        <>
          <p className="mb-2 text-[12.5px] text-muted-foreground">
            Sample at {clockWithSeconds(sample.t, timeZone)}
          </p>
          <p className="mb-0.5 text-[19px] font-semibold">CPU {percent(sample.cpuBusyPercent)}</p>
          <p className="text-muted-foreground">
            {sample.bucket !== undefined &&
              `5-minute high ${percent(sample.bucket.high)}, average ${percent(sample.bucket.average)}. `}
            Memory {formatGiB(sample.memoryUsedBytes)} of {formatGiB(sample.memoryTotalBytes)} GiB.
            Load {sample.load1.toFixed(1)}.
          </p>
          <p className="mt-3.5 mb-2 text-[12.5px] text-muted-foreground">Running then</p>
          {sample.processes.length === 0 && sample.unlinked.length === 0 ? (
            <p className="text-[13.5px] text-muted-foreground">No Harness process or Session.</p>
          ) : (
            <ul>
              {sample.processes.map((process) => (
                <Entry
                  color={harnessColor(process.harness)}
                  dashed={false}
                  key={process.processId}
                  {...sampleProcessLine(process)}
                />
              ))}
              {sample.unlinked.map((session) => (
                <Entry
                  color={harnessColor(session.harness)}
                  dashed
                  key={`${session.harness}-${session.sessionId}`}
                  {...unlinkedLine(session)}
                />
              ))}
            </ul>
          )}
        </>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Select any point on the axis to inspect its sample.
      </p>
    </aside>
  );
}
