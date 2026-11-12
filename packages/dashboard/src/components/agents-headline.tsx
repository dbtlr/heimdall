import { isRunning, runningCount, RUNNING_TITLE, wholeDollars } from '../lib/home-agents.ts';
import { formatCost } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { AgentsOverview, AgentsRange } from '../server/agents-overview-types.ts';

const RANGE_NAMES: Record<AgentsRange, string> = {
  '30d': '30 days',
  '7d': '7 days',
  today: 'today',
};

// The period's name in running text: "30 days", "today".
export const rangeName = (range: AgentsRange): string => RANGE_NAMES[range];

// What is usually spent by now: whole dollars from $10, cents below.
const usualText = (usd: number) => (usd >= 10 ? wholeDollars(usd) : formatCost(usd));

function Figure({
  className,
  label,
  note,
  title,
  value,
}: {
  className?: string | undefined;
  label: string;
  note: string;
  title?: string;
  value: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn('text-[26px] leading-tight font-semibold tabular-nums', className)}>
        {value}
      </p>
      <p className="text-[13px] text-muted-foreground">{note}</p>
    </div>
  );
}

// The projects of the running Sessions, two at most.
const runningProjects = ({ now, sessions }: AgentsOverview): string => {
  const names = [
    ...new Set(
      sessions
        .filter(({ lastRequestAt }) => isRunning(lastRequestAt, now))
        .map(({ project, system }) => project ?? system),
    ),
  ];
  return names.length > 2
    ? `${names.slice(0, 2).join(', ')} and ${String(names.length - 2)} more`
    : names.join(', ');
};

// The figures beside the page's title: what Today costs against what is
// usually spent by now, the period's total, and how many Sessions run. The
// Today range's total is Today's, so the two are one figure there. On a phone
// they sit in a card under the title, Today and Running now side by side, as
// in the picked mock; the period's total shows from 640 px up.
export function AgentsFigures({ overview }: { overview: AgentsOverview }) {
  const { range, today, totals, usualByNow } = overview;
  const running = runningCount(overview.sessions, overview.now);
  return (
    <div className="card-surface grid grid-cols-2 gap-x-6 rounded-xl border p-4 sm:flex sm:flex-wrap sm:gap-x-10 sm:rounded-none sm:border-0 sm:bg-transparent sm:bg-none sm:p-0 sm:shadow-none">
      <Figure
        label="Today"
        note={`${today.unpricedRequests > 0 ? 'at least · ' : ''}${
          usualByNow === undefined ? 'no usual by now yet' : `usual by now ${usualText(usualByNow)}`
        }`}
        value={formatCost(today.pricedCostUsd)}
      />
      {range !== 'today' && (
        <div className="hidden sm:block">
          <Figure
            label={rangeName(range)}
            note={
              totals.unpricedRequests > 0
                ? `at least · ${String(totals.unpricedRequests)} unpriced`
                : 'at list price'
            }
            value={formatCost(totals.pricedCostUsd)}
          />
        </div>
      )}
      <Figure
        className={running > 0 ? 'text-status-good' : undefined}
        label="Running now"
        note={running > 0 ? runningProjects(overview) : 'none'}
        title={RUNNING_TITLE}
        value={String(running)}
      />
    </div>
  );
}
