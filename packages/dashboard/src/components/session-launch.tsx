import { Link } from '@tanstack/react-router';

import { costClassColor, roleText, shadeSeats } from '../lib/cost-roles.ts';
import { harnessName } from '../lib/lane.ts';
import { costliestOf, outlineOf, treeTotalText } from '../lib/launch-tree.ts';
import type { OutlineRow } from '../lib/launch-tree.ts';
import { whenAt } from '../lib/phrase.ts';
import { formatCost, formatSpan } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type {
  LaunchTree,
  SessionKey,
  SessionLaunch,
  SessionLauncher,
  SessionPlace,
  SessionTotals,
  TreeMember,
} from '../server/session-view-types.ts';
import { PhraseText } from './date-time.tsx';
import { RolePill } from './role-pill.tsx';

const SESSION_PAGE = '/systems/$name/sessions/$harness/$source/$sessionId';

const paramsOf = ({ harness, sessionId, source, system }: SessionKey) => ({
  harness,
  name: system,
  sessionId,
  source,
});

function Label({ children }: { children: string }) {
  return <p className="mb-1 text-[13.5px] text-muted-foreground">{children}</p>;
}

// "heimdall on main": what a Session worked on, as its page's title names it.
const workedOn = (place: SessionPlace) => {
  const project = place.project ?? `${harnessName(place.harness)} Session`;
  return place.branch === undefined ? project : `${project} on ${place.branch}`;
};

const unresolvedText: Record<Exclude<SessionLauncher['state'], 'resolved'>, string> = {
  ambiguous: 'Unresolved: more than one Session the Hub holds has this id.',
  self: 'Unresolved: the id names this Session itself.',
  unmatched:
    "Unresolved: no single Session the Hub holds has this id. It links if that Session's transcripts arrive.",
};

// The launching Session, linked when it resolves; else its raw id and why it
// does not link; else that the Session's tag named none.
function LaunchedBy({ launcher, now }: { launcher: SessionLauncher | undefined; now: number }) {
  if (launcher === undefined) {
    return (
      <div>
        <Label>Launched by</Label>
        <p className="text-[13.5px] text-muted-foreground">Not recorded</p>
      </div>
    );
  }
  if (launcher.state !== 'resolved') {
    return (
      <div>
        <Label>Launched by</Label>
        <p className="font-mono text-[13px] break-all">{launcher.id}</p>
        <p className="text-[13.5px] text-muted-foreground">{unresolvedText[launcher.state]}</p>
      </div>
    );
  }
  const { session } = launcher;
  return (
    <div>
      <Label>Launched by</Label>
      <Link
        className="font-semibold text-link wrap-anywhere hover:underline"
        params={paramsOf(session)}
        to={SESSION_PAGE}
      >
        {workedOn(session)}
      </Link>
      <p className="text-[13.5px] text-muted-foreground">
        {harnessName(session.harness)} on {session.system}
        {session.startedAt !== undefined && (
          <PhraseText phrase={[', ', whenAt(session.startedAt, now)]} />
        )}
        , Session {session.sessionId.slice(0, 8)}
      </p>
    </div>
  );
}

// The Session's role, and where it came from when that was T3 Code's preamble.
function RoleBlock({ launch }: { launch: SessionLaunch }) {
  return (
    <div>
      <Label>Role</Label>
      {launch.role === undefined ? (
        <p className="text-[13.5px] text-muted-foreground">None recorded</p>
      ) : (
        <RolePill role={launch.role} seat={launch.seat} />
      )}
      {launch.roleSource === 'preamble' && (
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          {launch.role === 'review'
            ? "from T3's preamble; the brief had no session tag, so no seat or launcher"
            : "from T3's preamble; the brief had no session tag, so no launcher"}
        </p>
      )}
    </div>
  );
}

// The dot that marks a member's role: its seat's shade for a review, else its
// class's color. Seats are shaded by their cost over the tree, so members on
// one seat share its shade.
const dotColors = (members: readonly TreeMember[]) => {
  const seatCosts = new Map<string | null, number>();
  for (const member of members) {
    if (member.roleClass === 'review') {
      const seat = member.seat ?? null;
      seatCosts.set(seat, (seatCosts.get(seat) ?? 0) + member.pricedCostUsd);
    }
  }
  const shaded = shadeSeats([...seatCosts].map(([seat, cost]) => ({ cost, seat })));
  const bySeat = new Map(shaded.map((row) => [row.seat, row.shade]));
  return (member: TreeMember) =>
    member.roleClass === 'review'
      ? (bySeat.get(member.seat ?? null) ?? costClassColor('review'))
      : costClassColor(member.roleClass);
};

// How many levels the outline indents, so a deep tree still fits a phone.
const INDENT_LEVELS = 6;

const memberCost = (member: TreeMember) =>
  member.costUsd === undefined
    ? `at least ${formatCost(member.pricedCostUsd)}`
    : formatCost(member.costUsd);

function OutlineLine({
  color,
  costliest,
  now,
  row: { depth, member },
}: {
  color: string;
  costliest: number;
  now: number;
  row: OutlineRow;
}) {
  const label = roleText(member.role ?? null, member.seat ?? null);
  const isRoot = depth === 0;
  // Each level indents by one step, up to the cap; the elbow and the dot take
  // the first. A member past the cap shows its depth in the indent, left of its
  // elbow, so the capped rows stay aligned.
  const indent = { paddingLeft: Math.max(0, Math.min(depth, INDENT_LEVELS) - 1) * 16 };
  const deep = depth > INDENT_LEVELS;
  return (
    <tr className="border-t align-top">
      <td className="py-2" style={indent}>
        <span className="flex min-w-0 items-center gap-2">
          {deep && (
            <span
              aria-label={`depth ${String(depth)}`}
              className="-ml-7 w-5 flex-none text-right text-[12px] text-muted-foreground tabular-nums"
            >
              {depth}
            </span>
          )}
          {!isRoot && <span className="w-2.5 flex-none text-muted-foreground">└</span>}
          <i
            aria-hidden
            className="size-2.5 flex-none rounded-[3px]"
            style={{ background: color }}
          />
          {isRoot ? (
            <span className="min-w-0 truncate">
              <b className="font-semibold">{label ?? 'This Session'}</b>
              {label !== null && <span className="text-muted-foreground"> this Session</span>}
            </span>
          ) : (
            <Link
              className="min-w-0 truncate font-semibold text-link hover:underline"
              params={paramsOf(member)}
              to={SESSION_PAGE}
            >
              {label ?? workedOn(member)}
            </Link>
          )}
        </span>
        <span
          className={cn(
            'block text-[12.5px] text-muted-foreground',
            isRoot ? 'pl-[18px]' : 'pl-[36px]',
          )}
        >
          {harnessName(member.harness)} on {member.system}
          {member.startedAt !== undefined && (
            <PhraseText phrase={[', ', whenAt(member.startedAt, now)]} />
          )}
          {member.startedAt !== undefined &&
            member.endedAt !== undefined &&
            `, ${formatSpan(member.endedAt - member.startedAt)}`}
        </span>
      </td>
      <td className="py-2 pl-3 text-right whitespace-nowrap tabular-nums">
        {member.totaled ? (
          memberCost(member)
        ) : (
          <span className="text-muted-foreground">not totaled yet</span>
        )}
      </td>
      <td className="hidden py-2 pt-3.5 pl-3 sm:table-cell">
        {member.totaled && (
          <div className="h-1.5 rounded-[2px] bg-accent">
            <div
              className="h-full rounded-[2px] bg-plot"
              style={{ width: `${String((member.pricedCostUsd / costliest) * 100)}%` }}
            />
          </div>
        )}
      </td>
    </tr>
  );
}

// The tree total over every Session in the tree, then the tree as an outline.
function TreeTotal({
  now,
  totals,
  tree,
}: {
  now: number;
  totals: SessionTotals;
  tree: LaunchTree;
}) {
  const text = treeTotalText(tree, totals);
  const rows = outlineOf(tree.members);
  const colorOf = dotColors(tree.members);
  const costliest = costliestOf(tree.members);
  return (
    <div className="min-w-0">
      <Label>Tree total</Label>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-[18px] gap-y-1.5">
        <span className="text-[22px] font-semibold tabular-nums">{text.value}</span>
        <span className="text-[13px] text-muted-foreground">
          {text.note}{' '}
          {text.own === undefined ? (
            "This Session's own total is not stored yet."
          ) : (
            <>
              This Session alone
              <span className="hidden sm:inline">, subagents included,</span> is {text.own}.
            </>
          )}
        </span>
      </div>
      {/* Fixed columns, so a long role truncates and the costs stay aligned. */}
      <table className="w-full table-fixed text-[13.5px]">
        <thead>
          <tr className="text-left text-[12.5px] text-muted-foreground">
            <th className="pb-1.5 font-normal">Session</th>
            {/* Wide enough on a phone for "not totaled yet" or "at least" only when one appears. */}
            <th
              className={cn(
                'pb-1.5 text-right font-normal sm:w-28',
                tree.members.every((member) => member.costUsd !== undefined)
                  ? 'w-[4.75rem]'
                  : 'w-28',
              )}
            >
              Cost
            </th>
            <th className="hidden w-[24%] pb-1.5 sm:table-cell" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <OutlineLine
              color={colorOf(row.member)}
              costliest={costliest}
              key={JSON.stringify(paramsOf(row.member))}
              now={now}
              row={row}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The launch-tree card under the totals: who launched the Session and its
// role on the left, and on the right the tree total over every Session it
// launched, directly or through others. Phones stack the two.
export function SessionLaunchCard({
  launch,
  now,
  totals,
}: {
  launch: SessionLaunch;
  now: number;
  totals: SessionTotals;
}) {
  const { tree } = launch;
  return (
    <section
      aria-label="Launch tree"
      className={cn(
        'mt-3.5 grid gap-4 card-surface rounded-xl border p-4',
        tree !== undefined && 'sm:grid-cols-[280px_minmax(0,1fr)] sm:gap-x-7',
      )}
    >
      <div
        className={cn(
          'flex flex-col gap-4',
          tree === undefined
            ? 'sm:flex-row sm:gap-x-12'
            : 'border-b pb-3.5 sm:border-r sm:border-b-0 sm:pr-6 sm:pb-0',
        )}
      >
        <LaunchedBy launcher={launch.launcher} now={now} />
        <RoleBlock launch={launch} />
      </div>
      {tree !== undefined && <TreeTotal now={now} totals={totals} tree={tree} />}
    </section>
  );
}
