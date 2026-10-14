import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { harnessName } from '../lib/lane.ts';
import { clockSecondsAt } from '../lib/phrase.ts';
import { modelColor, tokenLine } from '../lib/session-format.ts';
import { MAIN } from '../lib/session-search.ts';
import type { SessionSearch } from '../lib/session-search.ts';
import { density, descendantLanes, filterTrace, traceEntries } from '../lib/session.ts';
import type { AgentLane, TraceEntry, TraceFilter } from '../lib/session.ts';
import { formatCost, formatSpan } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { SessionRequest, SessionToolCall, SessionView } from '../server/session-view-types.ts';
import { DateTime, PhraseText } from './date-time.tsx';
import { sessionWindow } from './session-timeline.tsx';
import { SpanLabels } from './span-labels.tsx';

const FILTERS: { filter: TraceFilter; label: string }[] = [
  { filter: 'everything', label: 'Everything' },
  { filter: 'main', label: 'Main conversation' },
  { filter: 'subagents', label: 'Subagents' },
  { filter: 'tools', label: 'Requests with tool calls' },
];

// A folded subagent shows this many of its requests until asked for the rest.
const FIRST_ROWS = 8;
const DENSITY_BINS = 120;

// The time, agent, what happened, and cost columns of a Trace row; on a phone,
// what happened wraps under the rest.
const ROW =
  'grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 border-b border-border/50 px-2 py-[5px] text-[13px] sm:grid-cols-[64px_150px_1fr_auto]';

function Swatch({ color }: { color: string }) {
  return (
    <i
      className="mr-1.5 inline-block h-2 w-3.5 flex-none rounded-[2px]"
      style={{ background: color }}
    />
  );
}

function Chips({ calls }: { calls: readonly SessionToolCall[] }) {
  return calls.map((call) => (
    <span
      className="ml-1.5 inline-block rounded-[3px] bg-accent px-1.5 text-[11.5px]"
      key={call.callId}
    >
      {call.name}
      {call.mcpServer !== undefined && (
        <span className="text-muted-foreground"> {call.mcpServer}</span>
      )}
    </span>
  ));
}

// The id of a request's row, so the selected one can be scrolled to.
const rowId = (requestId: string) => `request-${requestId}`;

// One request: its time, agent, tokens and tool calls, and cost.
function RequestRow({
  agent,
  calls,
  request,
  selected,
}: {
  agent: string;
  calls: readonly SessionToolCall[];
  request: SessionRequest;
  selected: boolean;
}) {
  return (
    <div
      className={cn(ROW, selected && 'bg-[rgba(255,214,102,0.14)] outline outline-[#ffd666]/60')}
      id={rowId(request.requestId)}
    >
      <span className="text-muted-foreground tabular-nums">
        <DateTime at={request.at} format="clockSeconds" />
      </span>
      <span className="truncate">
        <Swatch color={modelColor(request.model)} />
        {agent}
      </span>
      <span className="col-span-3 col-start-1 row-start-2 text-muted-foreground sm:col-span-1 sm:col-start-3 sm:row-start-1">
        {tokenLine(request)}
        <Chips calls={calls} />
        {request.interrupted && <span className="ml-1.5 text-status-serious">interrupted</span>}
      </span>
      <span className="col-start-3 row-start-1 text-right tabular-nums sm:col-start-4">
        {formatCost(request.costUsd)}
      </span>
    </div>
  );
}

// A line that marks something other than a request: a start, a process link,
// a command, a skill, a pause.
function EventRow({ children, marker, t }: { children: ReactNode; marker: ReactNode; t: number }) {
  return (
    <div className={cn(ROW, 'text-muted-foreground')}>
      <DateTime at={t} className="tabular-nums" format="clockSeconds" />
      <span className="col-span-2 sm:col-span-3">
        {marker}
        {children}
      </span>
    </div>
  );
}

const eventText = (entry: TraceEntry, view: SessionView): ReactNode => {
  const harness = harnessName(view.harness);
  switch (entry.kind) {
    case 'start': {
      return `Session starts${entry.cwd === undefined ? '' : ` in ${entry.cwd}`}${entry.branch === undefined ? '' : ` on ${entry.branch}`}.`;
    }
    case 'link': {
      const { stretch } = entry;
      if (stretch.link === 'linked') {
        return `Requests answered by ${harness} pid ${String(stretch.pid)}, linked.`;
      }
      return stretch.link === 'ambiguous'
        ? `Process link ambiguous: ${String(stretch.candidates)} ${harness} processes could have answered these requests.`
        : `No ${harness} process the Collector saw could have answered these requests.`;
    }
    case 'command': {
      return `/${entry.name} command.`;
    }
    case 'skill': {
      return `${entry.skill} skill starts.`;
    }
    case 'pause': {
      return (
        <i>
          {entry.waiting
            ? `Waiting ${formatSpan(entry.ms)} for a reply.`
            : `No requests for ${formatSpan(entry.ms)}.`}
        </i>
      );
    }
    default: {
      return '';
    }
  }
};

const MARKERS: Partial<Record<TraceEntry['kind'], ReactNode>> = {
  command: <i className="mr-2 inline-block h-3 w-0.5 bg-[#ffd666] align-middle" />,
  link: <i className="mr-2 inline-block h-1.5 w-2.5 rounded-[2px] bg-chart-1 align-middle" />,
  skill: <ChevronRight className="mr-1.5 inline size-3.5 text-[#ffd666]" />,
  start: <i className="mr-2 inline-block h-1.5 w-2.5 rounded-[2px] bg-chart-1 align-middle" />,
};

// A subagent the main conversation or a workflow run started, folded to one
// row; unfolded, its requests and its own subagents', the first few until
// asked for the rest.
function SubagentRow({
  callsOf,
  entry,
  go,
  lanes,
  open,
  selected,
  toggle,
}: {
  callsOf: (request: SessionRequest) => SessionToolCall[];
  entry: Extract<TraceEntry, { kind: 'subagent' }>;
  go: (next: Partial<SessionSearch>) => void;
  lanes: readonly AgentLane[];
  open: boolean;
  selected: string | undefined;
  toggle: () => void;
}) {
  const { lane } = entry;
  const family = [lane, ...descendantLanes(lanes, lane)];
  const requests = family
    .flatMap((member) => member.requests.map((request) => ({ member, request })))
    .toSorted((a, b) => a.request.at - b.request.at);
  const holdsSelected = requests.some(({ request }) => request.requestId === selected);
  const [all, setAll] = useState(holdsSelected);
  const calls = family.reduce((sum, member) => sum + member.toolCalls, 0);
  const shown = all ? requests : requests.slice(0, FIRST_ROWS);
  return (
    <>
      <div className={cn(ROW, 'bg-card/60')}>
        <DateTime
          at={lane.startedAt}
          className="text-muted-foreground tabular-nums"
          format="clockSeconds"
        />
        <button aria-expanded={open} className="truncate text-left" onClick={toggle} type="button">
          {open ? (
            <ChevronDown className="mr-1 inline size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="mr-1 inline size-3.5 text-muted-foreground" />
          )}
          <Swatch color={modelColor(lane.model ?? '')} />
          {lane.label}
        </button>
        <span className="col-span-3 col-start-1 row-start-2 sm:col-span-1 sm:col-start-3 sm:row-start-1">
          <b className="font-semibold">Subagent</b>{' '}
          {lane.phase === undefined ? '' : `In ${lane.phase}. `}
          <PhraseText phrase={['until ', clockSecondsAt(lane.endedAt), ', ']} />
          {formatSpan(lane.endedAt - lane.startedAt)}. {requests.length} requests, {calls} tool
          calls
          {entry.nested === 0
            ? ''
            : `, ${String(entry.nested)} ${entry.nested === 1 ? 'subagent' : 'subagents'} of its own`}
          .{' '}
          <button
            className="text-primary underline-offset-2 hover:underline"
            onClick={() => go({ lane: lane.agentId, request: undefined, tab: 'timeline' })}
            type="button"
          >
            See its lane
          </button>
        </span>
        <span className="col-start-3 row-start-1 text-right tabular-nums sm:col-start-4">
          {formatCost(lane.costUsd)}
        </span>
      </div>
      {open && (
        <div className="border-l-2 border-l-accent pl-3">
          {shown.map(({ member, request }) => (
            <RequestRow
              agent={member.label}
              calls={callsOf(request)}
              key={request.requestId}
              request={request}
              selected={request.requestId === selected}
            />
          ))}
          {!all && requests.length > FIRST_ROWS && (
            <button
              className="px-2 py-1.5 text-[13px] text-primary hover:underline"
              onClick={() => setAll(true)}
              type="button"
            >
              Show {requests.length - FIRST_ROWS} more
            </button>
          )}
        </div>
      )}
    </>
  );
}

// Requests per slice of the span, as bars over the axis.
function DensityStrip({ view }: { view: SessionView }) {
  const window = sessionWindow(view);
  const bins = density(view.requests, window, DENSITY_BINS);
  const most = Math.max(1, ...bins);
  return (
    <div className="mb-3.5" aria-label="Requests over the Session" role="img">
      <div className="flex h-8 items-end gap-px rounded-[3px] border-b">
        {bins.map((count, index) => (
          <i
            className="flex-1 bg-chart-1/80"
            // oxlint-disable-next-line react/no-array-index-key -- bins are positions.
            key={index}
            style={{ height: `${String((count / most) * 100)}%` }}
          />
        ))}
      </div>
      <SpanLabels window={window} />
    </div>
  );
}

// The Trace tab: the Session in order, every main-conversation request with
// its tool calls and each subagent folded, narrowed by a filter or to one
// agent's requests.
export function SessionTrace({
  go,
  lanes,
  search,
  view,
}: {
  go: (next: Partial<SessionSearch>) => void;
  lanes: readonly AgentLane[];
  search: SessionSearch;
  view: SessionView;
}) {
  const byRequest = useMemo(() => {
    const calls = new Map<string, SessionToolCall[]>();
    for (const call of view.toolCalls) {
      if (call.kind === 'tool' && call.requestId !== undefined) {
        const found = calls.get(call.requestId);
        if (found === undefined) {
          calls.set(call.requestId, [call]);
        } else {
          found.push(call);
        }
      }
    }
    return calls;
  }, [view]);
  const entries = useMemo(() => traceEntries(view, lanes), [view, lanes]);
  // Scrolls to the selected request when the selection changes, not each time
  // a fold or filter brings its row back.
  useEffect(() => {
    if (search.request !== undefined) {
      document.getElementById(rowId(search.request))?.scrollIntoView({ block: 'center' });
    }
  }, [search.request]);
  const callsOf = (request: SessionRequest) => byRequest.get(request.requestId) ?? [];
  const selectedRequest = view.requests.find((request) => request.requestId === search.request);
  // The top-level subagent that holds the selected request opens with it.
  const holder = lanes.find(
    (lane) =>
      lane.depth === 1 &&
      selectedRequest?.agentId !== undefined &&
      [lane, ...descendantLanes(lanes, lane)].some(
        (member) => member.agentId === selectedRequest.agentId,
      ),
  );
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () => new Set(holder?.agentId === undefined ? [] : [holder.agentId]),
  );
  const toggle = (agentId: string) => {
    setOpened((previous) => {
      const next = new Set(previous);
      if (!next.delete(agentId)) {
        next.add(agentId);
      }
      return next;
    });
  };
  const narrowed =
    search.agent === undefined
      ? undefined
      : lanes.find((lane) => (lane.agentId ?? MAIN) === search.agent);
  return (
    <>
      <DensityStrip view={view} />
      <section className="rounded-lg bg-card px-2 pt-2 pb-3 sm:px-3">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 px-2">
          {narrowed === undefined ? (
            <p className="text-[13px] text-muted-foreground">Trace, oldest first</p>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              Requests of <b className="font-semibold text-foreground">{narrowed.label}</b>, oldest
              first.{' '}
              <button
                className="text-primary hover:underline"
                onClick={() => go({ agent: undefined })}
                type="button"
              >
                Show the whole Trace
              </button>
            </p>
          )}
          {narrowed === undefined && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
              {FILTERS.map(({ filter, label }) => (
                <button
                  aria-pressed={search.filter === filter}
                  className={cn(
                    'rounded-[4px] px-2.5 py-1 text-[12.5px] text-muted-foreground',
                    search.filter === filter && 'bg-accent text-foreground',
                  )}
                  key={filter}
                  onClick={() => go({ filter })}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {narrowed === undefined
          ? filterTrace(entries, search.filter).map((entry, index) => {
              if (entry.kind === 'request') {
                return (
                  <RequestRow
                    agent="Main"
                    calls={entry.toolCalls}
                    key={entry.request.requestId}
                    request={entry.request}
                    selected={entry.request.requestId === search.request}
                  />
                );
              }
              if (entry.kind === 'subagent') {
                const agentId = entry.lane.agentId ?? '';
                return (
                  <SubagentRow
                    callsOf={callsOf}
                    entry={entry}
                    go={go}
                    key={agentId}
                    lanes={lanes}
                    open={opened.has(agentId)}
                    selected={search.request}
                    toggle={() => toggle(agentId)}
                  />
                );
              }
              return (
                <EventRow
                  key={`${entry.kind}-${String(entry.at)}-${String(index)}`}
                  marker={MARKERS[entry.kind]}
                  t={entry.at}
                >
                  {eventText(entry, view)}
                </EventRow>
              );
            })
          : narrowed.requests.map((request) => (
              <RequestRow
                agent={narrowed.agentId === undefined ? 'Main' : narrowed.label}
                calls={callsOf(request)}
                key={request.requestId}
                request={request}
                selected={request.requestId === search.request}
              />
            ))}
      </section>
    </>
  );
}
