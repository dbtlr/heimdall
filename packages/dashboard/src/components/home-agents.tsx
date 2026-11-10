import { Link } from '@tanstack/react-router';

import { shownRunning, wholeDollars } from '../lib/home-agents.ts';
import { harnessName } from '../lib/lane.ts';
import { modelName } from '../lib/session-format.ts';
import { formatCost, formatSpan, formatWeekday } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import { NO_KEY, UNKNOWN_MODEL } from '../server/agents-overview-types.ts';
import type { AgentsSession } from '../server/agents-overview-types.ts';
import type { DayCost, HomeAgents } from '../server/home-types.ts';

const ROW = 'border-t first:border-t-0';

// What is usually spent by now: whole dollars from $10, cents below.
const usualText = (usd: number) => (usd >= 10 ? wholeDollars(usd) : formatCost(usd));

// The day's cost, "At least" when a request in it has no list price.
const dayCostText = ({ pricedCostUsd, unpricedRequests }: DayCost) =>
  `${unpricedRequests > 0 ? 'at least ' : ''}${formatCost(pricedCostUsd)}`;

const barColor = (day: DayCost, today: boolean): string => {
  if (today) {
    return 'bg-select';
  }
  return day.pricedCostUsd === 0 ? 'bg-border' : 'bg-plot';
};

// A bar per day, each as tall as its cost beside the costliest, today in the
// selection color and the days before it in the plot color. A day that spent
// nothing keeps a hairline, today's still in the selection color, so the week
// reads as seven days.
function DayBars({ days, timeZone }: { days: readonly DayCost[]; timeZone: string }) {
  const most = Math.max(0, ...days.map(({ pricedCostUsd }) => pricedCostUsd));
  const label = days
    .map(
      (day, index) =>
        `${index === days.length - 1 ? 'today' : formatWeekday(day.start, timeZone)} ${dayCostText(day)}`,
    )
    .join(', ');
  return (
    <div className="w-[44%] max-w-48 flex-none">
      <div
        aria-label={`Cost per day over the last 7 days: ${label}`}
        className="flex h-[46px] items-end gap-[3px]"
        role="img"
      >
        {days.map((day, index) => {
          const today = index === days.length - 1;
          const height = most === 0 ? 0 : (day.pricedCostUsd / most) * 100;
          return (
            <span
              className={cn('min-h-px flex-1 rounded-t-[2px]', barColor(day, today))}
              key={day.start}
              style={{ height: `${String(height)}%` }}
              title={`${today ? 'Today' : formatWeekday(day.start, timeZone)}: ${dayCostText(day)}`}
            />
          );
        })}
      </div>
      <p className="mt-1 text-right text-xs text-dim">last 7 days</p>
    </div>
  );
}

// Today's list-price cost, large, marked "At least" when a request has no
// list price, and what is usually spent by now when enough days show it.
function TodayCost({ agents }: { agents: HomeAgents }) {
  const { today, usualByNow } = agents;
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-x-2">
        {today.unpricedRequests > 0 && (
          <span className="rounded-md bg-secondary px-1.5 text-xs font-semibold text-muted-foreground">
            At least
          </span>
        )}
        <span className="text-[28px] leading-tight font-semibold tracking-[-0.01em] tabular-nums">
          {formatCost(today.pricedCostUsd)}
        </span>
      </p>
      <p className="text-[13px] text-muted-foreground">
        today
        {usualByNow !== undefined && ` · usually ${usualText(usualByNow)} by now`}
      </p>
    </div>
  );
}

const modelText = (model: string | undefined): string | undefined => {
  if (model === undefined) {
    return undefined;
  }
  return model === NO_KEY ? UNKNOWN_MODEL : modelName(model);
};

// One running Session, linking to its page: a live mark, its project and
// branch, its cost so far, and under them its System, Harness, the model it
// asks most, and how long since it started.
function RunningRow({ now, session }: { now: number; session: AgentsSession }) {
  const facts = [
    session.system,
    harnessName(session.harness),
    modelText(session.topModel),
    formatSpan(Math.max(0, now - session.firstRequestAt)),
  ].filter((fact) => fact !== undefined);
  return (
    <li className={ROW}>
      <Link
        className="block py-2 hover:underline"
        params={{
          harness: session.harness,
          name: session.system,
          sessionId: session.sessionId,
          source: session.source,
        }}
        to="/systems/$name/sessions/$harness/$source/$sessionId"
      >
        <span className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span
              aria-label="Running"
              className="size-2 flex-none self-center rounded-full bg-status-good"
              role="img"
            />
            <span className="min-w-0 truncate text-[14px] font-semibold">
              {session.project ??
                `${harnessName(session.harness)} Session ${session.sessionId.slice(0, 8)}`}
              {session.branch !== undefined && (
                <span className="text-[13px] font-normal text-muted-foreground">
                  {' '}
                  {session.branch}
                </span>
              )}
            </span>
          </span>
          <span className="flex-none text-[14px] tabular-nums">
            {session.unpricedRequests > 0 && (
              <span className="text-xs text-muted-foreground">at least </span>
            )}
            {formatCost(session.pricedCostUsd)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
          {facts.join(' · ')}
        </span>
      </Link>
    </li>
  );
}

// The running Sessions, 5 at most with "+N more" after them, or, with none
// running, when the latest Session's last request was.
function Running({ agents, now }: { agents: HomeAgents; now: number }) {
  const { more, shown } = shownRunning(agents.running);
  if (shown.length === 0) {
    return (
      <p className="mt-3 border-t pt-2.5 text-[13px] text-muted-foreground">
        No Session is running.
        {agents.latestRequestAt !== undefined &&
          ` The latest ended ${formatSpan(Math.max(0, now - agents.latestRequestAt))} ago.`}
      </p>
    );
  }
  return (
    <>
      <ul aria-label="Sessions running now" className="mt-2.5">
        {shown.map((session) => (
          <RunningRow
            key={JSON.stringify([
              session.system,
              session.harness,
              session.source,
              session.sessionId,
            ])}
            now={now}
            session={session}
          />
        ))}
      </ul>
      {more > 0 && (
        <Link className="mt-1 inline-block text-[13px] text-link hover:underline" to="/agents">
          +{more} more
        </Link>
      )}
    </>
  );
}

// Home's Agents card: today's list-price cost against what is usually spent
// by now, the last 7 days' cost, and the Sessions running now. It waits for
// the viewer's time zone, which its days are counted in, and says so when no
// Session was ever recorded.
export function AgentsCard({ agents, now }: { agents: HomeAgents | undefined; now: number }) {
  let body;
  if (agents === undefined) {
    body = (
      <p className="text-[13px] text-muted-foreground" role="status">
        Loading agent work in your time zone…
      </p>
    );
  } else if (agents.running.length === 0 && agents.latestRequestAt === undefined) {
    body = <p className="text-[13px] text-muted-foreground">No agent Session has been recorded.</p>;
  } else {
    body = (
      <>
        <div className="flex items-start justify-between gap-4">
          <TodayCost agents={agents} />
          <DayBars days={agents.days} timeZone={agents.timeZone} />
        </div>
        <Running agents={agents} now={now} />
      </>
    );
  }
  return (
    <section
      aria-labelledby="home-agents"
      className="min-w-0 card-surface rounded-xl border px-4 py-3.5"
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2
          className="text-[11px] font-semibold tracking-[0.08em] text-dim uppercase"
          id="home-agents"
        >
          Agents
        </h2>
        <Link className="text-xs text-link hover:underline" to="/agents">
          Spend and Sessions →
        </Link>
      </div>
      {body}
    </section>
  );
}
