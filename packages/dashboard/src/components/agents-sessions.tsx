import { Link } from '@tanstack/react-router';

import { nextSort, pageButtons, pageCount, pageRange, sortSearch } from '../lib/agents-sessions.ts';
import { isRunning, RUNNING_TITLE } from '../lib/home-agents.ts';
import { harnessColor, harnessName } from '../lib/lane.ts';
import { formatCost, formatPast, formatSpan } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import { NO_KEY } from '../server/agents-overview-types.ts';
import type {
  AgentsBreakdown,
  AgentsSession,
  SessionSort,
  SessionsPage,
  SortDirection,
} from '../server/agents-overview-types.ts';

// A Session lists a model it used; it sits in a project, on a System, or of a Harness.
const filterPreposition = (by: AgentsBreakdown) => (by === 'model' ? 'using' : 'in');

const COLUMNS: { align?: 'right'; label: string; sort: SessionSort }[] = [
  { label: 'Started', sort: 'started' },
  { label: 'Project · branch', sort: 'project' },
  { label: 'Harness', sort: 'harness' },
  { label: 'Top model', sort: 'model' },
  { label: 'System', sort: 'system' },
  { align: 'right', label: 'Duration', sort: 'duration' },
  { align: 'right', label: 'Requests', sort: 'requests' },
  { align: 'right', label: 'Cost', sort: 'cost' },
];

// The phone's sort switch: the three orders worth a tap.
const PHONE_SORTS: { dir: SortDirection; label: string; sort: SessionSort }[] = [
  { dir: 'desc', label: 'Newest', sort: 'started' },
  { dir: 'desc', label: 'Cost', sort: 'cost' },
  { dir: 'desc', label: 'Duration', sort: 'duration' },
];

const sessionKey = (session: AgentsSession) =>
  JSON.stringify([session.system, session.harness, session.source, session.sessionId]);

const titleOf = (session: AgentsSession) =>
  session.project ?? `${harnessName(session.harness)} Session ${session.sessionId.slice(0, 8)}`;

const sessionParams = (session: AgentsSession) => ({
  harness: session.harness,
  name: session.system,
  sessionId: session.sessionId,
  source: session.source,
});

const SESSION_ROUTE = '/systems/$name/sessions/$harness/$source/$sessionId' as const;

// What a row or card needs: its Session, the time the page was read, and the
// viewer's zone, which the page knows before it shows the table.
type RowProps = { now: number; session: AgentsSession; timeZone: string };

function ProjectBranch({ session }: { session: AgentsSession }) {
  return (
    <>
      <b className="font-semibold">{titleOf(session)}</b>
      {session.branch !== undefined && (
        <span className="font-normal text-muted-foreground"> {session.branch}</span>
      )}
    </>
  );
}

// When the Session's first request was, dated once it is older than
// yesterday, since a Session in a 30-day range can be weeks old.
function Started({ now, session, timeZone }: RowProps) {
  return (
    <time className="tabular-nums" dateTime={new Date(session.firstRequestAt).toISOString()}>
      {formatPast(session.firstRequestAt, now, timeZone)}
    </time>
  );
}

function RunningTag({ className }: { className?: string }) {
  return (
    <span className={cn('text-status-good', className)} title={RUNNING_TITLE}>
      Running
    </span>
  );
}

function CostText({ session }: { session: AgentsSession }) {
  return (
    <>
      {session.unpricedRequests > 0 && (
        <span className="block text-xs font-normal text-muted-foreground">At least </span>
      )}
      {formatCost(session.pricedCostUsd)}
      {session.unpricedRequests > 0 && (
        <span className="block text-xs font-normal text-muted-foreground">
          {session.unpricedRequests} unpriced{' '}
          {session.unpricedRequests === 1 ? 'request' : 'requests'}
        </span>
      )}
    </>
  );
}

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;

function SortHeader({
  column,
  current,
}: {
  column: (typeof COLUMNS)[number];
  current: { dir: SortDirection; sort: SessionSort };
}) {
  const active = current.sort === column.sort;
  const next = nextSort(current, column.sort);
  return (
    <th
      aria-sort={active ? ARIA_SORT[current.dir] : undefined}
      className={cn('px-2 font-medium', column.align === 'right' ? 'text-right' : 'text-left')}
      scope="col"
    >
      <Link
        className={cn(
          'inline-flex min-h-11 items-center gap-1 whitespace-nowrap hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          active && 'text-select',
        )}
        resetScroll={false}
        search={(previous) => ({ ...previous, ...sortSearch(next), page: undefined })}
        to="."
      >
        {column.label}
        {active && <span aria-hidden="true">{current.dir === 'asc' ? '▲' : '▼'}</span>}
      </Link>
    </th>
  );
}

function SessionRow({ now, session, timeZone }: RowProps) {
  return (
    <tr className="relative border-b border-border/60 hover:bg-card focus-within:bg-card">
      <td className="px-2 py-3 align-top whitespace-nowrap tabular-nums">
        <Started now={now} session={session} timeZone={timeZone} />
        {isRunning(session.lastRequestAt, now) && <RunningTag className="block text-xs" />}
      </td>
      <td className="max-w-72 px-2 py-3 align-top break-words">
        <Link
          className="after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          params={sessionParams(session)}
          to={SESSION_ROUTE}
        >
          <ProjectBranch session={session} />
        </Link>
      </td>
      <td className="px-2 py-3 align-top whitespace-nowrap">
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ background: harnessColor(session.harness) }}
          />
          {harnessName(session.harness)}
        </span>
      </td>
      <td className="max-w-48 px-2 py-3 align-top font-mono text-sm break-all">
        {session.topModel === undefined || session.topModel === NO_KEY ? (
          <span className="text-muted-foreground">unknown</span>
        ) : (
          session.topModel
        )}
      </td>
      <td className="px-2 py-3 align-top break-words text-muted-foreground">{session.system}</td>
      <td className="px-2 py-3 text-right align-top whitespace-nowrap tabular-nums">
        {formatSpan(session.lastRequestAt - session.firstRequestAt)}
      </td>
      <td className="px-2 py-3 text-right align-top tabular-nums">{session.requests}</td>
      <td className="px-2 py-3 text-right align-top font-semibold whitespace-nowrap tabular-nums">
        <CostText session={session} />
      </td>
    </tr>
  );
}

function SessionCard({ now, session, timeZone }: RowProps) {
  return (
    <li className="relative flex gap-3 border-b border-border/60 py-3 last:border-b-0">
      <span
        aria-hidden="true"
        className={cn(
          'mt-1.5 size-2.5 shrink-0 rounded-full',
          isRunning(session.lastRequestAt, now) && 'ring-2 ring-offset-2 ring-offset-card',
        )}
        style={{ background: harnessColor(session.harness) }}
      />
      <div className="min-w-0 flex-1">
        <Link
          className="block break-words after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          params={sessionParams(session)}
          to={SESSION_ROUTE}
        >
          <ProjectBranch session={session} />
        </Link>
        <p className="mt-0.5 text-sm break-words text-muted-foreground">
          {harnessName(session.harness)} · {session.system} ·{' '}
          <Started now={now} session={session} timeZone={timeZone} /> ·{' '}
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

function PhoneSortSwitch({ current }: { current: { dir: SortDirection; sort: SessionSort } }) {
  return (
    <nav
      aria-label="Sort Sessions"
      className="mb-2 inline-flex rounded-[10px] border bg-background p-[3px] sm:hidden"
    >
      {PHONE_SORTS.map((option) => {
        const active = option.sort === current.sort && option.dir === current.dir;
        return (
          <Link
            aria-current={active ? 'true' : undefined}
            className={cn(
              'flex min-h-11 items-center rounded-lg px-3 text-[15px] text-muted-foreground',
              active && 'bg-accent font-semibold text-foreground',
            )}
            key={option.label}
            resetScroll={false}
            search={(previous) => ({ ...previous, ...sortSearch(option), page: undefined })}
            to="."
          >
            {option.label}
          </Link>
        );
      })}
    </nav>
  );
}

const PAGE_LINK =
  'flex min-h-11 min-w-9 items-center justify-center rounded-md px-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function PageLink({ label, page, current }: { current?: boolean; label: string; page: number }) {
  return (
    <Link
      aria-current={current === true ? 'page' : undefined}
      className={cn(
        PAGE_LINK,
        current === true ? 'border border-select bg-select/15 font-semibold' : 'hover:bg-accent',
      )}
      resetScroll={false}
      search={(previous) => ({ ...previous, page: page === 1 ? undefined : page })}
      to="."
    >
      {label}
    </Link>
  );
}

// Prev or Next: a link to the neighbouring page, or, at the first or last
// page, the same label muted and disabled, so the pager never shifts.
function PageStep({ label, page }: { label: string; page: number | undefined }) {
  return page === undefined ? (
    <span aria-disabled="true" className={cn(PAGE_LINK, 'text-muted-foreground/60')}>
      {label}
    </span>
  ) : (
    <PageLink label={label} page={page} />
  );
}

function Pager({ rangeText, table }: { rangeText: string; table: SessionsPage }) {
  const pages = pageCount(table.total);
  const { first, last } = pageRange(table.page, table.sessions.length);
  const previous = table.page > 1 ? table.page - 1 : undefined;
  const next = table.page < pages ? table.page + 1 : undefined;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <p className="text-sm text-muted-foreground tabular-nums">
        {first}–{last} of {table.total} {table.total === 1 ? 'Session' : 'Sessions'} {rangeText}
      </p>
      {pages > 1 && (
        <>
          <nav aria-label="Pages" className="hidden items-center gap-0.5 sm:flex">
            <PageStep label="‹ Prev" page={previous} />
            {pageButtons(table.page, pages).map((button, index) =>
              button === 'gap' ? (
                // oxlint-disable-next-line react/no-array-index-key -- a gap has no number of its own.
                <span
                  aria-hidden="true"
                  className="px-1 text-muted-foreground"
                  key={`gap-${index}`}
                >
                  …
                </span>
              ) : (
                <PageLink
                  current={button === table.page}
                  key={button}
                  label={String(button)}
                  page={button}
                />
              ),
            )}
            <PageStep label="Next ›" page={next} />
          </nav>
          <nav aria-label="Pages" className="flex items-center gap-2 sm:hidden">
            <PageStep label="‹ Prev" page={previous} />
            <PageStep label="Next ›" page={next} />
          </nav>
        </>
      )}
    </div>
  );
}

// The Sessions of the period in a table, sortable by each column, and as
// cards on a phone. `pick` names the breakdown row, of dimension `by`, the
// list is filtered to, if any. `rangeText` finishes "of 96 Sessions …".
// Times are written in `timeZone`, the viewer's.
export function AgentsSessions({
  by,
  dir,
  now,
  pick,
  rangeText,
  sort,
  table,
  timeZone,
}: {
  by: AgentsBreakdown;
  dir: SortDirection;
  now: number;
  pick?: string | undefined;
  rangeText: string;
  sort: SessionSort;
  table: SessionsPage;
  timeZone: string;
}) {
  const preposition = filterPreposition(by);
  const current = { dir, sort };
  return (
    <section
      aria-labelledby="agents-sessions-heading"
      className="card-surface rounded-xl border px-3 py-4 sm:px-4"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 className="text-base font-semibold" id="agents-sessions-heading">
          Sessions
        </h2>
        <p className="hidden text-xs text-muted-foreground sm:block">
          running Sessions pin to the top
        </p>
      </div>
      {pick !== undefined && (
        <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Sessions {preposition}</span>
          <Link
            aria-label={`Show all Sessions, not only those ${preposition} ${pick}`}
            className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-select bg-select/15 px-3 break-all"
            resetScroll={false}
            search={(previous) => ({ ...previous, page: undefined, pick: undefined })}
            to="."
          >
            {pick}
            <svg aria-hidden="true" height="9" viewBox="0 0 10 10" width="9">
              <path d="M1 1l8 8M9 1l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </Link>
        </p>
      )}
      {table.sessions.length === 0 ? (
        <p className="card-surface rounded-xl border px-4 py-5 text-muted-foreground">
          {pick === undefined
            ? 'No requests in this period.'
            : `No Sessions ${preposition} ${pick} in this period.`}
        </p>
      ) : (
        <>
          <PhoneSortSwitch current={current} />
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  {COLUMNS.map((column) => (
                    <SortHeader column={column} current={current} key={column.sort} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.sessions.map((session) => (
                  <SessionRow
                    key={sessionKey(session)}
                    now={now}
                    session={session}
                    timeZone={timeZone}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <ul className="sm:hidden">
            {table.sessions.map((session) => (
              <SessionCard
                key={sessionKey(session)}
                now={now}
                session={session}
                timeZone={timeZone}
              />
            ))}
          </ul>
          <Pager rangeText={rangeText} table={table} />
        </>
      )}
    </section>
  );
}
