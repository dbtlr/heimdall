import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { changeLink, changeWords } from '../lib/home-changes.ts';
import type { ChangeLink } from '../lib/home-changes.ts';
import { JOBS_SHOWN, jobWords } from '../lib/home-jobs.ts';
import type { MaintenanceCard } from '../lib/home-maintenance.ts';
import { whenAt } from '../lib/phrase.ts';
import { MAINTENANCE_STATUS } from '../lib/sections.ts';
import { cn } from '../lib/utils.ts';
import type { ChangeGroup, HomeJob, JobState } from '../server/home-types.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { PhraseText } from './date-time.tsx';

const ROW = 'border-t first:border-t-0';

const ROW_LINE = 'flex min-w-0 items-baseline justify-between gap-3';

// One of Home's cards: an eyebrow heading, an optional link at its right, and
// its body.
export function HomeCard({
  children,
  id,
  link,
  title,
}: {
  children: ReactNode;
  id: string;
  link?: ReactNode;
  title: string;
}) {
  return (
    <section aria-labelledby={id} className="min-w-0 card-surface rounded-xl border px-4 py-3.5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-dim uppercase" id={id}>
          {title}
        </h2>
        {link}
      </div>
      {children}
    </section>
  );
}

// What a card says when it has nothing to list.
function Empty({ children }: { children: string }) {
  return <p className="text-[13px] text-muted-foreground">{children}</p>;
}

const CARD_LINK = 'text-xs text-link hover:underline';

// The Systems under a Maintenance row, each linking to its Condition page.
function SystemLinks({
  systems,
}: {
  systems: readonly { conditionId: string; count?: number; system: string }[];
}) {
  return (
    <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      {systems.map(({ conditionId, count, system }) => (
        <Link
          className="hover:text-foreground hover:underline"
          key={conditionId}
          params={{ id: conditionId, name: system }}
          to="/systems/$name/conditions/$id"
        >
          {system}
          {count !== undefined && <span className="ml-1 tabular-nums text-dim">{count}</span>}
        </Link>
      ))}
    </p>
  );
}

// Home's Maintenance card: packages pending, Systems that need a reboot, and
// Services with an update, each row omitted when it has nothing. All of it
// can wait, so nothing here is tinted as a problem.
export function MaintenanceCardView({ card }: { card: MaintenanceCard }) {
  const { packages, reboots, updates } = card;
  const empty = packages === undefined && reboots === undefined && updates === undefined;
  return (
    <HomeCard
      id="home-maintenance"
      link={
        <Link className={CARD_LINK} search={{ status: [...MAINTENANCE_STATUS] }} to="/services">
          Plan →
        </Link>
      }
      title="Maintenance · can wait"
    >
      {empty ? (
        <Empty>Nothing to maintain.</Empty>
      ) : (
        <ul className="text-[13.5px]">
          {packages !== undefined && (
            <li className={cn(ROW, 'py-1.5')}>
              <div className={ROW_LINE}>
                <span>{packages.text}</span>
                {packages.security > 0 && (
                  <span
                    className={cn(
                      'flex-none rounded-full bg-status-warning/15 px-2 py-0.5 text-xs whitespace-nowrap',
                      MARK_COLOR.note,
                    )}
                  >
                    {packages.security} security
                  </span>
                )}
              </div>
              <SystemLinks
                systems={packages.systems.map(({ conditionId, packages: count, system }) => ({
                  conditionId,
                  count,
                  system,
                }))}
              />
            </li>
          )}
          {reboots !== undefined && (
            <li className={cn(ROW, 'py-1.5')}>
              <div className={ROW_LINE}>
                <span>{reboots.text}</span>
                <span className="flex-none text-xs text-muted-foreground">{reboots.oldest}</span>
              </div>
              <SystemLinks systems={reboots.systems} />
            </li>
          )}
          {updates !== undefined && (
            <li className={ROW}>
              <Link
                className={cn(ROW_LINE, 'min-h-9 items-center hover:underline')}
                search={{ status: [...MAINTENANCE_STATUS] }}
                to="/services"
              >
                <span>{updates.text}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {updates.longest}
                </span>
              </Link>
            </li>
          )}
        </ul>
      )}
    </HomeCard>
  );
}

// A link to where a group of changes leads.
function ChangeTarget({
  children,
  className,
  link,
}: {
  children: ReactNode;
  className: string;
  link: ChangeLink;
}) {
  switch (link.to) {
    case 'service': {
      return (
        <Link
          className={className}
          params={{ name: link.system, service: link.service }}
          to="/systems/$name/services/$service"
        >
          {children}
        </Link>
      );
    }
    case 'services': {
      return (
        <Link className={className} search={{ system: link.systems }} to="/services">
          {children}
        </Link>
      );
    }
    case 'condition': {
      return (
        <Link
          className={className}
          params={{ id: link.id, name: link.system }}
          to="/systems/$name/conditions/$id"
        >
          {children}
        </Link>
      );
    }
    default: {
      return (
        <Link className={className} to="/timeline">
          {children}
        </Link>
      );
    }
  }
}

// Home's What changed card: the newest groups of changes of the last day, each
// with its time and the Systems it happened on, leading to the most specific
// page.
export function ChangesCard({ changes, now }: { changes: readonly ChangeGroup[]; now: number }) {
  return (
    <HomeCard
      id="home-changes"
      link={
        <Link className={CARD_LINK} to="/timeline">
          Activity →
        </Link>
      }
      title="What changed · 24 h"
    >
      {changes.length === 0 ? (
        <Empty>Nothing changed in the last 24 hours.</Empty>
      ) : (
        <ul className="text-[13.5px]">
          {changes.map((group) => {
            const { detail, mono, title } = changeWords(group);
            return (
              <li className={ROW} key={`${title}-${String(group.at)}`}>
                <ChangeTarget className="block py-1.5 hover:underline" link={changeLink(group)}>
                  <span className={ROW_LINE}>
                    <span className="min-w-0 truncate">{title}</span>
                    <span className="flex-none text-xs text-dim tabular-nums">
                      <PhraseText phrase={[whenAt(group.at, now)]} />
                    </span>
                  </span>
                  {detail !== '' && (
                    <span
                      className={cn(
                        'block truncate text-xs text-muted-foreground',
                        mono && 'font-mono',
                      )}
                    >
                      {detail}
                    </span>
                  )}
                </ChangeTarget>
              </li>
            );
          })}
        </ul>
      )}
    </HomeCard>
  );
}

const JOB_COLOR: Record<JobState, string> = {
  due: 'text-muted-foreground',
  failing: MARK_COLOR.alert,
  ok: 'text-status-good',
  overdue: MARK_COLOR.warning,
};

// Home's Jobs card: every recorded job, failing first, then overdue, then the
// most recent run, at most JOBS_SHOWN of them, each linking to its System's
// Records tab.
export function JobsCard({ jobs, now }: { jobs: readonly HomeJob[]; now: number }) {
  const shown = jobs.slice(0, JOBS_SHOWN);
  const more = jobs.length - shown.length;
  return (
    <HomeCard id="home-jobs" title="Jobs">
      {jobs.length === 0 ? (
        <Empty>No job is recorded.</Empty>
      ) : (
        <ul className="text-[13.5px]">
          {shown.map((job) => (
            <li className={ROW} key={`${job.system}/${job.name}`}>
              <Link
                className={cn(ROW_LINE, 'min-h-9 items-center hover:underline')}
                params={{ name: job.system }}
                search={{ tab: 'records' }}
                to="/systems/$name"
              >
                <span className="min-w-0 truncate">
                  {job.name} <span className="text-xs text-muted-foreground">{job.system}</span>
                </span>
                <span
                  className={cn('flex-none text-xs whitespace-nowrap', JOB_COLOR[job.state])}
                  data-state={job.state}
                >
                  <PhraseText phrase={jobWords(job, now)} />
                </span>
              </Link>
            </li>
          ))}
          {more > 0 && (
            <li className={cn(ROW, 'py-1.5 text-xs text-muted-foreground')}>+{more} more</li>
          )}
        </ul>
      )}
    </HomeCard>
  );
}
