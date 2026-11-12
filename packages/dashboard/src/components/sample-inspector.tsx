import { formatGiB, memoryHoldersView, sampleProcessLine, unlinkedLine } from '../lib/detail.ts';
import { harnessColor } from '../lib/lane.ts';
import { clockSecondsAt } from '../lib/phrase.ts';
import { cn } from '../lib/utils.ts';
import type { SampleInspection, SampleProcess } from '../server/system-detail-types.ts';
import { PhraseText } from './date-time.tsx';
import { MemoryHolders } from './memory-holders.tsx';
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
// bucket, memory and load, the processes holding the most memory, the Harness
// processes running then with their Sessions, and the Sessions no single
// process is linked to.
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
  const holders = memoryHoldersView(sample?.memoryHolders);
  return (
    <aside
      aria-busy={loading}
      className="max-h-[70dvh] self-start overflow-y-auto card-surface rounded-xl border-l-[3px] border-l-select px-4 py-3.5"
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
          <p className="mb-2 flex items-baseline gap-2">
            <b className="text-[17px] font-semibold tabular-nums">
              <PhraseText phrase={[clockSecondsAt(sample.t)]} />
            </b>
            <span className="text-[12.5px] text-muted-foreground">pinned sample</span>
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13.5px]">
            <dt className="text-muted-foreground">CPU busy</dt>
            <dd>
              <b className="font-semibold">{percent(sample.cpuBusyPercent)}</b>
              {sample.bucket !== undefined && (
                <span className="block text-xs text-muted-foreground">
                  bucket avg {Math.round(sample.bucket.average)}, high{' '}
                  {Math.round(sample.bucket.high)}
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">Memory</dt>
            <dd>
              <b className="font-semibold">
                {formatGiB(sample.memoryUsedBytes)} / {formatGiB(sample.memoryTotalBytes)} GB
              </b>
              {sample.memoryTotalBytes > 0 && (
                <span className="block text-xs text-muted-foreground">
                  {percent((sample.memoryUsedBytes / sample.memoryTotalBytes) * 100)} used
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">Load (1 min)</dt>
            <dd>
              <b className="font-semibold">{sample.load1.toFixed(1)}</b>
            </dd>
          </dl>
          <p className="mt-3.5 mb-2 text-[11px] font-semibold tracking-[0.08em] text-dim uppercase">
            Harness processes
          </p>
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
          {holders !== undefined && (
            <div className="mt-3.5">
              <MemoryHolders holders={holders} />
            </div>
          )}
        </>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Select any point on the axis to inspect its sample.
      </p>
    </aside>
  );
}
