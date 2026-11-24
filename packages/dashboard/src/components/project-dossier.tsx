import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { breakdownRows } from '../lib/agents-breakdown.ts';
import type { BreakdownRow } from '../lib/agents-breakdown.ts';
import { isRunning } from '../lib/home-agents.ts';
import { harnessColor, harnessName } from '../lib/lane.ts';
import { listNames } from '../lib/phrase.ts';
import { laneRows } from '../lib/project-activity.ts';
import { formatClock, formatCost, formatDate, formatPast, formatSpan } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import { NO_KEY } from '../server/agents-overview-types.ts';
import type { AgentsRange } from '../server/agents-overview-types.ts';
import type { ActivityLane, ProjectView, ToolCount } from '../server/project-view.ts';
import { AgentsChart } from './agents-chart.tsx';
import { rangeName } from './agents-headline.tsx';
import { AgentsRangePicker } from './agents-range-picker.tsx';
import {
  CostText,
  RunningTag,
  SESSION_ROUTE,
  sessionKey,
  sessionParams,
  Started,
} from './agents-sessions.tsx';
import { CostByRole } from './cost-by-role.tsx';
import { MoreItems } from './more-items.tsx';

// How many rows a ranked list shows before the rest fold into "N more".
export const LIST_SHOWN = 5;

const RANGE_DAYS: Partial<Record<AgentsRange, number>> = { '30d': 30, '7d': 7 };
const SHORT_RANGES: Record<AgentsRange, string> = { '30d': '30 d', '7d': '7 d', today: 'today' };

const gibibytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

// Whole hours from 10 hours up, tenths below, and minutes under an hour.
const activeText = (ms: number) => {
  const hours = ms / 3_600_000;
  if (hours < 1) {
    return formatSpan(ms);
  }
  return `${hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1)} h`;
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${String(count)} ${count === 1 ? one : many}`;

// The title block: on phones a back row to Agents, from 640 px the
// breadcrumb; then the name, a running badge while a Session runs, and the
// range picker; then, once times can be written in the viewer's zone, where
// the project lives and when it was active.
export function ProjectHeader({
  range,
  timeZone,
  view,
}: {
  range: AgentsRange;
  timeZone: string | undefined;
  view: ProjectView;
}) {
  const running = view.overview.running.length;
  const where = view.repository
    ? `Git repository on ${listNames(view.systems)}`
    : `Folder with no recorded repository, on ${listNames(view.systems)}`;
  return (
    <header className="space-y-1">
      <Link
        className="-ml-1 inline-flex min-h-11 items-center px-1 text-sm text-muted-foreground sm:hidden"
        search={{ range }}
        to="/agents"
      >
        ‹ Agents
      </Link>
      <p className="hidden text-sm text-muted-foreground sm:block">
        <Link className="hover:text-foreground" search={{ range }} to="/agents">
          Agents
        </Link>{' '}
        /
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="min-w-0 text-2xl font-semibold break-all">{view.name}</h1>
        {running > 0 && (
          <span className="rounded-full border border-status-good/50 px-2.5 py-0.5 text-sm text-status-good">
            {running} running
          </span>
        )}
        <div className="ml-auto">
          <AgentsRangePicker current={range} />
        </div>
      </div>
      {timeZone !== undefined && (
        <p className="text-sm text-muted-foreground">
          {where} · first Session {formatDate(view.firstSessionAt, timeZone)} · last request{' '}
          {view.lastRequestAt === undefined
            ? 'none yet'
            : formatPast(view.lastRequestAt, view.overview.now, timeZone)}
        </p>
      )}
    </header>
  );
}

// What the period cost per bar, as a line too small for a scale.
function Sparkline({ values }: { values: readonly number[] }) {
  const top = Math.max(...values, 0);
  if (values.length < 2 || top === 0) {
    return null;
  }
  const points = values
    .map((value, index) => {
      const x = 1 + (index / (values.length - 1)) * 88;
      const y = 20 - (value / top) * 18;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      aria-hidden="true"
      className="mt-2 text-primary"
      height="22"
      viewBox="0 0 90 22"
      width="90"
    >
      <polyline fill="none" points={points} stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

type Figure = {
  extra?: ReactNode;
  label: string;
  note: string;
  shortLabel: string;
  shortNote: string;
  value: string;
};

// The two labels and notes swap at 640 px, so phones' two-across tiles line up.
function FigureTile({ figure }: { figure: Figure }) {
  return (
    <div className="card-surface rounded-xl border p-3 sm:p-4">
      <h2 className="text-sm text-muted-foreground">
        <span className="sm:hidden">{figure.shortLabel}</span>
        <span className="hidden sm:inline">{figure.label}</span>
      </h2>
      <p className="my-1 text-2xl font-semibold tabular-nums">{figure.value}</p>
      <p className="text-xs text-muted-foreground">
        <span className="sm:hidden">{figure.shortNote}</span>
        <span className="hidden sm:inline">{figure.note}</span>
      </p>
      {figure.extra}
    </div>
  );
}

function ProjectFigures({ view }: { view: ProjectView }) {
  const { overview } = view;
  const { totals } = overview;
  const days = RANGE_DAYS[overview.range];
  const perBar = overview.chart.buckets.map((_, index) =>
    overview.chart.cells
      .filter((cell) => cell.bucket === index)
      .reduce((sum, cell) => sum + cell.pricedCostUsd, 0),
  );
  const unpriced = totals.unpricedRequests > 0 ? `${String(totals.unpricedRequests)} unpriced` : '';
  const peak = view.peakRssBytes;
  const figures: Figure[] = [
    {
      extra: <Sparkline values={perBar} />,
      label: 'List-price cost',
      note: [
        rangeName(overview.range),
        days === undefined ? '' : `${formatCost(totals.pricedCostUsd / days)} a day`,
        unpriced,
      ]
        .filter((part) => part !== '')
        .join(' · '),
      shortLabel: `Cost · ${SHORT_RANGES[overview.range]}`,
      shortNote: unpriced === '' ? 'at list price' : unpriced,
      value: `${totals.unpricedRequests > 0 ? 'At least ' : ''}${formatCost(totals.pricedCostUsd)}`,
    },
    {
      label: 'Active time',
      note: 'the 5 minutes after each request, overlaps once',
      shortLabel: 'Active time',
      shortNote: '5 min per request',
      value: activeText(view.activeMs),
    },
    {
      label: 'Sessions',
      note: `${plural(view.subagents, 'subagent')} · ${plural(totals.requests, 'request')}`,
      shortLabel: 'Sessions',
      shortNote: plural(view.subagents, 'subagent'),
      value: String(overview.sessionCount),
    },
    {
      label: 'Harness process CPU',
      note:
        peak === undefined
          ? 'no process readings in this period'
          : `peak memory ${gibibytes(peak)}, one process`,
      shortLabel: 'Process CPU',
      shortNote: peak === undefined ? 'no readings' : `peak ${gibibytes(peak)}`,
      value: `${(view.cpuSeconds / 3600).toFixed(1)} CPU-h`,
    },
  ];
  return (
    <section aria-label="Project totals" className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
      {figures.map((figure) => (
        <FigureTile figure={figure} key={figure.label} />
      ))}
    </section>
  );
}

const laneTitle = (lane: ActivityLane, now: number, timeZone: string) =>
  `${harnessName(lane.harness)} Session ${lane.sessionId.slice(0, 8)} on ${lane.system}, ${formatPast(lane.start, now, timeZone)} to ${lane.end >= now ? 'now' : formatClock(lane.end, timeZone)}`;

// A lane per System of the request activity of its Sessions, on the chart's
// time axis. Sessions that overlap stack into rows of their own, so none
// hides another. Rows are 24 px apart on phones, where each block's tap
// target is at least 24 px square; from 640 px they close up.
function ProjectLanes({ view }: { view: ProjectView }) {
  const { overview } = view;
  const { now, timeZone } = overview;
  // Each day or hour takes the width of its cost bar, DST days included.
  const position = (at: number) => {
    const { buckets } = overview.chart;
    const index = buckets.findIndex((bucket) => at < bucket.end);
    const bucket = buckets[index];
    if (index === -1 || bucket === undefined) {
      return 100;
    }
    return (
      ((index + Math.max(0, (at - bucket.start) / (bucket.end - bucket.start))) / buckets.length) *
      100
    );
  };
  // About a pixel of a wide chart: a Session's runs closer than that draw as one.
  const joinMs = (now - overview.from) / 1000;
  const systems = [...new Set(view.lanes.map((lane) => lane.system))].toSorted();
  return (
    <div className="space-y-3">
      {systems.map((system) => {
        const rows = laneRows(
          view.lanes.filter((lane) => lane.system === system),
          joinMs,
        );
        return (
          <div className="space-y-1" key={system}>
            <Link className="text-sm break-all" params={{ name: system }} to="/systems/$name">
              {system}
            </Link>
            <div
              className="relative rounded bg-muted/30 [--lane-row:1.5rem] sm:[--lane-row:0.75rem]"
              style={{ height: `calc(var(--lane-row) * ${String(rows.length)})` }}
            >
              {rows.map((row, index) =>
                row.map((lane) => {
                  const running = lane.end >= now;
                  return (
                    <Link
                      aria-label={`${laneTitle(lane, now, timeZone)}${running ? ', running' : ''}`}
                      className={cn(
                        "absolute h-2 min-w-1 rounded-sm before:absolute before:top-1/2 before:left-1/2 before:size-full before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] max-sm:before:h-6 max-sm:before:w-[max(100%,1.5rem)]",
                        running && 'ring-2 ring-foreground',
                      )}
                      data-lane-row={index}
                      key={JSON.stringify([lane.harness, lane.source, lane.sessionId, lane.start])}
                      params={sessionParams(lane)}
                      style={{
                        background: harnessColor(lane.harness),
                        left: `${String(position(lane.start))}%`,
                        top: `calc(var(--lane-row) * ${String(index)} + (var(--lane-row) - 0.5rem) / 2)`,
                        width: `${String(position(lane.end) - position(lane.start))}%`,
                      }}
                      title={laneTitle(lane, now, timeZone)}
                      to={SESSION_ROUTE}
                    />
                  );
                }),
              )}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        {formatDate(overview.from, timeZone)} — {formatDate(now, timeZone)} · request activity, the
        5 minutes after each request; overlapping Sessions stack
      </p>
    </div>
  );
}

type Ranked = { key: string; name: string; value: string; weight: number };

function RankedRow({ row, top }: { row: Ranked; top: number }) {
  return (
    <li className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-2 py-1 text-sm">
      <span className="truncate font-mono" title={row.name}>
        {row.name}
      </span>
      <span aria-hidden="true" className="h-2 rounded-sm bg-muted/40">
        <span
          className="block h-full rounded-sm bg-primary/70"
          style={{ width: `${String(top > 0 ? (row.weight / top) * 100 : 0)}%` }}
        />
      </span>
      <span className="text-right text-muted-foreground tabular-nums">{row.value}</span>
    </li>
  );
}

// A card of names, each with a bar as long as its share of the first row's
// weight. The first five show; the rest fold into "N more".
function RankedList({
  empty,
  footer,
  rows,
  title,
  unit,
}: {
  empty: string;
  footer?: ReactNode;
  rows: readonly Ranked[];
  title: string;
  unit?: string;
}) {
  const top = Math.max(0, ...rows.map((row) => row.weight));
  const rest = rows.slice(LIST_SHOWN);
  return (
    <section aria-label={title} className="card-surface rounded-xl border p-4">
      <h2 className="mb-2 flex justify-between font-semibold">
        {title}
        {unit !== undefined && (
          <span className="text-xs font-normal text-muted-foreground">{unit}</span>
        )}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul>
          {rows.slice(0, LIST_SHOWN).map((row) => (
            <RankedRow key={row.key} row={row} top={top} />
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <MoreItems label={`${String(rest.length)} more`}>
          <ul className="px-1">
            {rest.map((row) => (
              <RankedRow key={row.key} row={row} top={top} />
            ))}
          </ul>
        </MoreItems>
      )}
      {footer}
    </section>
  );
}

const costText = (row: BreakdownRow) =>
  row.pricing === 'none'
    ? 'No list price'
    : `${row.pricing === 'at-least' ? 'At least ' : ''}${formatCost(row.pricedCostUsd)}`;

const toolName = (tool: ToolCount) =>
  [tool.mcpServer, tool.name, tool.skill === null ? null : `skill · ${tool.skill}`]
    .filter(Boolean)
    .join(' · ');

function ProjectLists({ view }: { view: ProjectView }) {
  const models = breakdownRows(view.overview, 'model').map((row) => ({
    key: row.key,
    name: row.name,
    value: costText(row),
    weight: row.pricedCostUsd,
  }));
  const tools = view.tools.map((tool) => ({
    key: JSON.stringify([tool.name, tool.kind, tool.mcpServer, tool.skill]),
    name: toolName(tool),
    value: String(tool.calls),
    weight: tool.calls,
  }));
  const unlisted = view.toolCount - view.tools.length;
  const branches = view.branches.map((branch) => ({
    key: branch.name,
    name: branch.name,
    value: String(branch.sessions),
    weight: branch.sessions,
  }));
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <RankedList empty="No requests in this period." rows={models} title="Models" />
      <RankedList
        empty="No tool calls in this period."
        footer={
          <p className="mt-2 text-xs text-muted-foreground">
            {unlisted > 0 && `${plural(unlisted, 'name')} with fewer calls not listed. `}
            Names and counts only; no arguments or output.
          </p>
        }
        rows={tools}
        title="Tools and skills"
        unit="calls"
      />
      <RankedList
        empty="No recorded branch in this period."
        rows={branches}
        title="Branches"
        unit="Sessions"
      />
    </div>
  );
}

type TailSession = ProjectView['tail'][number]['session'];

const modelText = (session: TailSession) =>
  session.topModel === undefined || session.topModel === NO_KEY ? 'unknown' : session.topModel;

const TAIL_COLUMNS = [
  'Started',
  'System',
  'Harness',
  'Branch',
  'Model',
  'Subagents',
  'Duration',
  'Requests',
  'Cost',
] as const;
const RIGHT_COLUMNS = new Set<string>(['Subagents', 'Duration', 'Requests', 'Cost']);

function TailRow({
  now,
  session,
  subagents,
  timeZone,
}: {
  now: number;
  session: TailSession;
  subagents: number;
  timeZone: string;
}) {
  return (
    <tr className="relative border-b border-border/60 hover:bg-card focus-within:bg-card">
      <td className="px-2 py-2.5 align-top whitespace-nowrap">
        <Link
          className="after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          params={sessionParams(session)}
          to={SESSION_ROUTE}
        >
          <Started now={now} session={session} timeZone={timeZone} />
        </Link>
        {isRunning(session.lastRequestAt, now) && <RunningTag className="ml-2 text-xs" />}
      </td>
      <td className="px-2 py-2.5 align-top break-words text-muted-foreground">{session.system}</td>
      <td className="px-2 py-2.5 align-top whitespace-nowrap">
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ background: harnessColor(session.harness) }}
          />
          {harnessName(session.harness)}
        </span>
      </td>
      <td className="max-w-48 px-2 py-2.5 align-top font-mono break-all">
        {session.branch ?? '—'}
      </td>
      <td className="max-w-48 px-2 py-2.5 align-top font-mono break-all">{modelText(session)}</td>
      <td className="px-2 py-2.5 text-right align-top tabular-nums">{subagents}</td>
      <td className="px-2 py-2.5 text-right align-top whitespace-nowrap tabular-nums">
        {formatSpan(session.lastRequestAt - session.firstRequestAt)}
      </td>
      <td className="px-2 py-2.5 text-right align-top tabular-nums">{session.requests}</td>
      <td className="px-2 py-2.5 text-right align-top font-semibold whitespace-nowrap tabular-nums">
        <CostText session={session} />
      </td>
    </tr>
  );
}

function TailCard({
  now,
  session,
  timeZone,
}: {
  now: number;
  session: TailSession;
  timeZone: string;
}) {
  return (
    <li className="relative flex gap-3 border-b border-border/60 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <Link
          className="block font-semibold after:absolute after:inset-0"
          params={sessionParams(session)}
          to={SESSION_ROUTE}
        >
          <Started now={now} session={session} timeZone={timeZone} />
          {session.branch !== undefined && (
            <span className="font-mono font-normal text-muted-foreground"> {session.branch}</span>
          )}
        </Link>
        <p className="mt-0.5 text-sm break-words text-muted-foreground">
          {harnessName(session.harness)} · {session.system} ·{' '}
          {formatSpan(session.lastRequestAt - session.firstRequestAt)}
          {isRunning(session.lastRequestAt, now) && (
            <>
              {' · '}
              <RunningTag />
            </>
          )}
        </p>
      </div>
      <p className="shrink-0 font-semibold tabular-nums">
        <CostText session={session} />
      </p>
    </li>
  );
}

// The period's newest Sessions, running first, and a link to all of them on
// Agents, broken down by project and picked to this one over the same range.
function ProjectSessions({ view }: { view: ProjectView }) {
  const { overview } = view;
  const { now, timeZone } = overview;
  const count = overview.sessionCount;
  return (
    <section
      aria-labelledby="project-sessions-heading"
      className="card-surface rounded-xl border px-3 py-4 sm:px-4"
    >
      <h2 className="mb-2 text-base font-semibold" id="project-sessions-heading">
        Sessions <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
      </h2>
      {view.tail.length === 0 ? (
        <p className="text-muted-foreground">No requests in this period.</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  {TAIL_COLUMNS.map((column) => (
                    <th
                      className={cn(
                        'px-2 py-2 font-medium',
                        RIGHT_COLUMNS.has(column) && 'text-right',
                      )}
                      key={column}
                      scope="col"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.tail.map(({ session, subagents }) => (
                  <TailRow
                    key={sessionKey(session)}
                    now={now}
                    session={session}
                    subagents={subagents}
                    timeZone={timeZone}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <ul className="sm:hidden">
            {view.tail.map(({ session }) => (
              <TailCard key={sessionKey(session)} now={now} session={session} timeZone={timeZone} />
            ))}
          </ul>
          <Link
            className="mt-2 inline-flex min-h-11 items-center text-sm text-primary"
            search={{ by: 'project', pick: view.name, range: overview.range }}
            to="/agents"
          >
            {count > view.tail.length ? `All ${String(count)} Sessions ›` : 'Open in Agents ›'}
          </Link>
        </>
      )}
    </section>
  );
}

// The dossier below the header: totals, their cost by role, cost per day
// over a lane per System, models, tools and skills, branches, and the newest
// Sessions. It shares the Agents chart, breakdown, and cost by role card; the
// card leaves out the Agents page's missed-tag line.
export function ProjectDossier({ view }: { view: ProjectView }) {
  const { overview } = view;
  return (
    <>
      <ProjectFigures view={view} />
      <CostByRole
        periodName={overview.range === 'today' ? 'Today' : rangeName(overview.range)}
        split={view.roleSplit}
      />
      <AgentsChart
        belowPlot={<ProjectLanes view={view} />}
        by="harness"
        dossier
        overview={overview}
        pick={undefined}
      />
      <ProjectLists view={view} />
      <ProjectSessions view={view} />
      <p className="text-xs text-muted-foreground">
        Token usage at API list prices, including subagents. Subscription charges may differ.
        Amounts include only this period. Process CPU sums the period's measured rollup buckets;
        peak memory is the highest reading of one process in the period.
      </p>
    </>
  );
}
