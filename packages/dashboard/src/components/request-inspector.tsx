import { harnessName } from '../lib/lane.ts';
import { clockAt, clockSecondsAt } from '../lib/phrase.ts';
import { formatTokens, modelColor, modelName, stopLine } from '../lib/session-format.ts';
import type { SessionSearch } from '../lib/session-search.ts';
import { concurrentAt, stretchAt } from '../lib/session.ts';
import type { AgentLane } from '../lib/session.ts';
import { formatCost } from '../lib/time.ts';
import type { SessionRequest, SessionView } from '../server/session-view-types.ts';
import { PhraseText } from './date-time.tsx';

const percent = (value: number) => `${String(Math.round(value))}%`;

// Which process ran the request, as the Hub links its stretch.
const processLine = (view: SessionView, request: SessionRequest) => {
  const stretch = stretchAt(view.stretches, request.at);
  const harness = harnessName(view.harness);
  if (stretch?.link === 'linked') {
    return `${harness} pid ${String(stretch.pid)} ran it.`;
  }
  if (stretch?.link === 'ambiguous') {
    return `Ambiguous: ${String(stretch.candidates)} ${harness} processes could have run it.`;
  }
  return `No ${harness} process the Collector saw could have run it.`;
};

// CPU busy in the bucket that holds the request, and the cores its linked
// process kept busy then.
function SampleLine({ request, view }: { request: SessionRequest; view: SessionView }) {
  const bucket = view.cpu.find(
    (found) => found.t <= request.at && request.at < found.t + view.bucketMs,
  );
  if (bucket === undefined) {
    return <>No Vitals sample from then.</>;
  }
  const stretch = stretchAt(view.stretches, request.at);
  const cores =
    stretch?.link === 'linked'
      ? view.processes
          .find((process) => process.processId === stretch.processId)
          ?.points.find((point) => point.t === bucket.t)?.cores
      : undefined;
  return (
    <>
      <PhraseText phrase={['Sample ', clockAt(bucket.t), ': ']} />
      CPU {percent(bucket.high)} high, {percent(bucket.average)} average.
      {cores === undefined || cores === null || stretch === undefined
        ? ''
        : ` pid ${String(stretch.pid)} used ${cores.toFixed(1)} cores.`}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-border/60 py-1 text-[13.5px] last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

// The panel that inspects one request: what it cost and carried, the process
// that ran it and the System's CPU then, the other agents at work around it,
// and a link to its row in the Trace.
export function RequestInspector({
  go,
  lanes,
  request,
  view,
}: {
  go: (next: Partial<SessionSearch>) => void;
  lanes: readonly AgentLane[];
  request: SessionRequest | undefined;
  view: SessionView;
}) {
  const lane = lanes.find((found) => found.agentId === request?.agentId);
  return (
    <aside className="mt-2.5 self-start rounded-lg border-l-[3px] border-l-[#ffd666] bg-card px-4 py-3.5">
      {request === undefined || lane === undefined ? (
        <p className="text-muted-foreground">Select a request mark to inspect it.</p>
      ) : (
        <>
          <p className="mb-2 text-[12.5px] text-muted-foreground">
            <PhraseText phrase={['Request at ', clockSecondsAt(request.at)]} />
          </p>
          <p className="mb-0.5 text-[19px] font-semibold">
            {lane.label}, {modelName(request.model)}
          </p>
          <p className="text-muted-foreground">
            {request.costUsd === undefined
              ? 'Unpriced'
              : `${formatCost(request.costUsd)} list price`}
            {request.skill === undefined ? '' : `, in the ${request.skill} skill`}.{' '}
            {stopLine(request)}
          </p>
          <dl className="mt-2.5">
            <Fact label="Input" value={formatTokens(request.inputTokens)} />
            <Fact label="Output" value={formatTokens(request.outputTokens)} />
            <Fact label="Read from cache" value={formatTokens(request.cacheReadTokens)} />
            <Fact label="Written to cache" value={formatTokens(request.cacheWriteTokens)} />
            <Fact
              label="Context"
              value={
                request.contextWindow === undefined
                  ? formatTokens(request.contextTokens)
                  : `${formatTokens(request.contextTokens)} of ${formatTokens(request.contextWindow)}, ${percent((request.contextTokens / request.contextWindow) * 100)}`
              }
            />
          </dl>
          <p className="mt-3.5 mb-1 text-[12.5px] text-muted-foreground">Process</p>
          <p className="text-[13.5px]">{processLine(view, request)}</p>
          <p className="text-[13.5px] text-muted-foreground">
            <SampleLine request={request} view={view} />
          </p>
          <p className="mt-3.5 mb-1 text-[12.5px] text-muted-foreground">
            Running at the same time
          </p>
          <ConcurrentList lanes={lanes} request={request} />
          <button
            className="mt-3 text-[13.5px] text-primary underline-offset-2 hover:underline"
            onClick={() => go({ agent: undefined, filter: 'everything', tab: 'trace' })}
            type="button"
          >
            Show this request in Trace
          </button>
        </>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Select any request mark to inspect it. Transcript text stays on the Hub&apos;s System.
      </p>
    </aside>
  );
}

function ConcurrentList({
  lanes,
  request,
}: {
  lanes: readonly AgentLane[];
  request: SessionRequest;
}) {
  const others = concurrentAt(lanes, request.at, request.agentId);
  if (others.length === 0) {
    return <p className="text-[13.5px] text-muted-foreground">No other agent.</p>;
  }
  return (
    <ul>
      {others.map(({ lane, requests }) => (
        <li className="flex items-start gap-2 py-[3px] text-[13.5px]" key={lane.agentId ?? 'main'}>
          <i
            className="mt-[5px] inline-block h-2 w-3.5 flex-none rounded-[2px]"
            style={{ background: modelColor(lane.model ?? '') }}
          />
          <span>
            <b className="font-semibold">{lane.label}</b>
            <br />
            <span className="text-muted-foreground">
              {requests} {requests === 1 ? 'request' : 'requests'} within a minute of this one
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
