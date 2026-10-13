import { useEffect, useRef } from 'react';

import { spanTicks } from '../lib/axis.ts';
import { modelColor, modelFamily, modelName } from '../lib/session-format.ts';
import type { SessionSearch } from '../lib/session-search.ts';
import { commandMarks } from '../lib/session.ts';
import type { AgentLane } from '../lib/session.ts';
import { formatClock, formatCost, inWindow, xPercent } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { SessionRequest, SessionView } from '../server/session-view-types.ts';
import { CpuPlot } from './cpu-plot.tsx';
import { DetailAxis, DetailRow, DetailTrack } from './detail-track.tsx';
import { LANE_GRID } from './fleet-lane.tsx';
import { ProcessLinkBar } from './process-link-bar.tsx';
import { ProcessPlot } from './process-plot.tsx';
import { RequestInspector } from './request-inspector.tsx';
import { TimeAxis } from './time-axis.tsx';

const SWATCH = 'inline-block h-2 w-3.5 flex-none rounded-[2px]';

// The Session's span as the axis shows it; a Session of one request still
// gets a minute.
export const sessionWindow = (view: SessionView): Window => ({
  from: view.startedAt,
  to: Math.max(view.endedAt, view.startedAt + 60_000),
});

// The request nearest `t`, if there is any.
export const nearestRequest = (
  requests: readonly SessionRequest[],
  t: number,
): SessionRequest | undefined =>
  requests.reduce<SessionRequest | undefined>(
    (best, request) =>
      best === undefined || Math.abs(request.at - t) < Math.abs(best.at - t) ? request : best,
    undefined,
  );

// What the lanes' marks mean: one swatch per model in the Session.
function TimelineLegend({ lanes, view }: { lanes: readonly AgentLane[]; view: SessionView }) {
  const models = [...new Set(view.requests.map((request) => request.model))];
  return (
    <p className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
      {models.map((model) => (
        <span className="inline-flex items-center gap-[5px]" key={model}>
          <i className={SWATCH} style={{ background: modelColor(model) }} />
          {modelName(model)} request
        </span>
      ))}
      {lanes.length > 1 && (
        <span className="inline-flex items-center gap-[5px]">
          <i className="inline-block h-px w-3.5 bg-muted-foreground" />
          subagent running
        </span>
      )}
      {view.stretches.some((stretch) => stretch.link === 'ambiguous') && (
        <span className="inline-flex items-center gap-[5px]">
          <i
            className={cn(SWATCH, 'border border-dashed border-chart-1 bg-chart-1/30')}
            aria-hidden="true"
          />
          ambiguous process link
        </span>
      )}
    </p>
  );
}

// A workflow run's name: the skill its agents' requests share, if one.
export const runName = (lanes: readonly AgentLane[], run: string) => {
  const skills = new Set(
    lanes
      .filter((lane) => lane.workflowRun === run)
      .flatMap((lane) => lane.requests.map((request) => request.skill)),
  );
  const [only] = skills;
  return skills.size === 1 && only !== undefined ? `${only} workflow run` : 'Workflow run';
};

// One agent as a lane: its name, model, and cost beside a mark per request,
// over a line while it ran. Selecting the track picks its nearest request.
function LaneRow({
  commands,
  lane,
  onPick,
  pointed,
  window,
}: {
  commands: ReturnType<typeof commandMarks>;
  lane: AgentLane;
  onPick: (request: SessionRequest) => void;
  pointed: boolean;
  window: Window;
}) {
  const row = useRef<HTMLElement>(null);
  useEffect(() => {
    if (pointed) {
      row.current?.scrollIntoView({ block: 'center' });
    }
  }, [pointed]);
  return (
    <section
      aria-label={lane.label}
      className={cn(LANE_GRID, 'py-1', pointed && 'rounded-md bg-accent')}
      ref={row}
    >
      <div
        className="flex items-baseline justify-between gap-2 text-[13.5px]"
        style={{ paddingLeft: Math.max(0, lane.depth - 1) * 12 }}
      >
        <p className="truncate">
          {lane.depth > 0 && <span className="mr-1.5 text-muted-foreground">└</span>}
          <b className="font-semibold">{lane.label}</b>
          {lane.phase !== undefined && <span className="text-muted-foreground"> {lane.phase}</span>}
          {lane.model !== undefined && (
            <span className="text-muted-foreground"> {modelFamily(lane.model)}</span>
          )}
        </p>
        <p className="flex-none text-muted-foreground">{formatCost(lane.costUsd)}</p>
      </div>
      <DetailTrack
        onSelect={(t) => {
          const found = nearestRequest(lane.requests, t);
          if (found !== undefined) {
            onPick(found);
          }
        }}
      >
        <div className="relative h-5">
          <div
            className="absolute top-1/2 h-px bg-muted-foreground/60"
            style={{
              left: `${String(xPercent(Math.max(lane.startedAt, window.from), window))}%`,
              width: `${String(xPercent(Math.min(lane.endedAt, window.to), window) - xPercent(Math.max(lane.startedAt, window.from), window))}%`,
            }}
          />
          {lane.requests.map((request) => (
            <i
              className="absolute top-0.5 h-4 w-px"
              key={request.requestId}
              style={{
                background: modelColor(request.model),
                left: `${String(xPercent(request.at, window))}%`,
              }}
            />
          ))}
          {commands
            .filter((command) => inWindow(command.at, window))
            .map((command) => (
              <span
                className="absolute -top-1.5 z-10 rounded-[3px] border-l-2 border-l-[#ffd666] bg-accent px-1 text-[11px] whitespace-nowrap"
                key={`${command.name}-${String(command.at)}`}
                style={{ left: `${String(xPercent(command.at, window))}%` }}
              >
                /{command.name}
              </span>
            ))}
        </div>
      </DetailTrack>
    </section>
  );
}

// The Timeline tab: a lane per agent, then CPU busy, the Harness processes'
// cores, and the process link on the Session's span, beside the inspector of
// the request selected.
export function SessionTimeline({
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
  const window = sessionWindow(view);
  const { timeZone } = view;
  const selected = view.requests.find((request) => request.requestId === search.request);
  const pick = (request: SessionRequest) => go({ lane: undefined, request: request.requestId });
  const commands = commandMarks(view.requests, view.toolCalls);
  return (
    // Agent lanes carry a type, a phase, and a model, so their labels run longer.
    <div className="grid gap-x-[18px] [--lane-label:236px] lg:grid-cols-[1fr_290px]">
      <DetailAxis
        onSelect={(t) => {
          const found = nearestRequest(view.requests, t);
          if (found !== undefined) {
            pick(found);
          }
        }}
        selected={selected?.at}
        window={window}
      >
        <div className="min-w-0">
          <TimelineLegend lanes={lanes} view={view} />
          <div className="border-t pt-1.5 pb-1">
            {lanes.map((lane, index) => {
              const run = lane.workflowRun;
              const startsRun = run !== undefined && lanes[index - 1]?.workflowRun !== run;
              return (
                <div key={lane.agentId ?? 'main'}>
                  {startsRun && (
                    <p className="pt-2 pb-0.5 text-[11.5px] tracking-[0.06em] text-muted-foreground uppercase">
                      {runName(lanes, run)}
                    </p>
                  )}
                  <LaneRow
                    commands={lane.agentId === undefined ? commands : []}
                    lane={lane}
                    onPick={pick}
                    pointed={search.lane !== undefined && search.lane === lane.agentId}
                    window={window}
                  />
                </div>
              );
            })}
          </div>
          <DetailRow label="CPU busy" note={view.system}>
            <CpuPlot
              bucketMs={view.bucketMs}
              buckets={view.cpu}
              height={60}
              label="CPU busy"
              timeZone={timeZone}
              window={window}
            />
          </DetailRow>
          <DetailRow label="Harness processes" note="CPU cores, by process">
            <ProcessPlot bucketMs={view.bucketMs} processes={view.processes} window={window} />
          </DetailRow>
          <DetailRow label="Process link">
            <ProcessLinkBar
              harness={view.harness}
              stretches={view.stretches}
              timeZone={timeZone}
              window={window}
            />
          </DetailRow>
          <TimeAxis ticks={spanTicks(window, timeZone)} window={window}>
            {selected !== undefined && (
              <span
                className="absolute -top-px -translate-x-1/2 rounded-[3px] bg-[#ffd666] px-[9px] font-semibold text-background"
                style={{ left: `${String(xPercent(selected.at, window))}%` }}
              >
                {formatClock(selected.at, timeZone)}
              </span>
            )}
          </TimeAxis>
        </div>
      </DetailAxis>
      <RequestInspector go={go} lanes={lanes} request={selected} view={view} />
    </div>
  );
}
