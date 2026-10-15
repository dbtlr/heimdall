import { formatGiB, sampleProcessLine, unlinkedLine } from '../lib/detail.ts';
import { harnessColor } from '../lib/lane.ts';
import { clockSecondsAt } from '../lib/phrase.ts';
import { cn } from '../lib/utils.ts';
import type { SampleInspection, SampleProcess } from '../server/system-detail-types.ts';
import { PhraseText } from './date-time.tsx';
import { MoreItems } from './more-items.tsx';

const percent = (value: number) => `${String(Math.round(value))}%`;

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

function ProcessEntry({ process }: { process: SampleProcess }) {
  return (
    <Entry color={harnessColor(process.harness)} dashed={false} {...sampleProcessLine(process)} />
  );
}

// The panel that inspects one Vitals sample: its CPU against its 5-minute
// bucket, memory and load, the Harness processes running then with their
// Sessions, and the Sessions no single process is linked to.
export function SampleInspector({
  failed,
  loading = false,
  sample,
}: {
  failed: boolean;
  loading?: boolean;
  sample: SampleInspection | null;
}) {
  const idle =
    sample?.processes.filter((process) => process.cores === 0 && process.requests === 0) ?? [];
  const active =
    sample?.processes.filter((process) => process.cores !== 0 || process.requests !== 0) ?? [];
  return (
    <aside
      aria-busy={loading}
      className="mt-2.5 max-h-[70dvh] self-start overflow-y-auto rounded-lg border-l-[3px] border-l-[#ffd666] bg-card px-4 py-3.5"
    >
      {loading && <p role="status">Reading sample…</p>}
      {sample === null && !loading && (
        <p className="text-muted-foreground">
          {failed
            ? 'The sample could not be read. Select a time to try again.'
            : 'No Vitals sample to inspect.'}
        </p>
      )}
      {sample !== null && (
        <>
          <p className="mb-2 text-[12.5px] text-muted-foreground">
            <PhraseText phrase={['Sample at ', clockSecondsAt(sample.t)]} />
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
              {active.map((process) => (
                <ProcessEntry key={process.processId} process={process} />
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
          {idle.length > 0 && (
            <MoreItems
              label={`${String(idle.length)} idle ${idle.length === 1 ? 'process' : 'processes'}`}
            >
              <ul>
                {idle.map((process) => (
                  <ProcessEntry key={process.processId} process={process} />
                ))}
              </ul>
            </MoreItems>
          )}
        </>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Select any point on the axis to inspect its sample.
      </p>
    </aside>
  );
}
