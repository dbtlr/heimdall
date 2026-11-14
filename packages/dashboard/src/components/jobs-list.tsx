import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { dueWords, latestRunWords, scheduleWords } from '../lib/jobs.ts';
import type { StripCell } from '../lib/jobs.ts';
import { cn } from '../lib/utils.ts';
import type { JobsRow } from '../server/jobs-types.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { PhraseText } from './date-time.tsx';

const CELL: Record<StripCell['kind'], string> = {
  failed: 'bg-status-critical',
  missed: 'border border-dashed border-status-warning',
  ok: 'bg-status-good/80',
};

const CELL_WORDS: Record<StripCell['kind'], string> = {
  failed: 'failed',
  missed: 'missed',
  ok: 'succeeded',
};

// A job's last runs, oldest first, one cell each: succeeded, failed, or a
// scheduled time that passed with no run. Without cells the Hub holds no run
// history for the job, which is not the same as runs it missed.
function Strip({ cells }: { cells: readonly StripCell[] | undefined }) {
  if (cells === undefined) {
    return <span className="text-xs text-muted-foreground">history not sent</span>;
  }
  return (
    <span
      aria-label={`Last ${String(cells.length)} runs: ${cells.map(({ kind }) => CELL_WORDS[kind]).join(', ')}`}
      className="flex h-4 items-center gap-[3px]"
      role="img"
    >
      {cells.map(({ at, kind }) => (
        <span
          className={cn('h-4 w-2 shrink-0 rounded-[2px]', CELL[kind])}
          data-kind={kind}
          key={`${String(at)}/${kind}`}
        />
      ))}
    </span>
  );
}

// The level: a chip for a failing or overdue job, a dot for the rest.
function Level({ job }: { job: JobsRow }) {
  if (job.state === 'failing' || job.state === 'overdue') {
    return (
      <span
        className={cn(
          'rounded-full border px-2 py-0.5 text-xs font-semibold',
          job.state === 'failing' ? MARK_COLOR.alert : MARK_COLOR.warning,
        )}
      >
        {job.state === 'failing' ? 'Failing' : 'Overdue'}
      </span>
    );
  }
  return (
    <>
      <span aria-hidden="true" className="inline-block size-2 rounded-full bg-status-good" />
      <span className="sr-only">OK</span>
    </>
  );
}

const jobKey = (job: JobsRow) => `${job.system}/${job.name}`;

function JobName({ job, withSystem = false }: { job: JobsRow; withSystem?: boolean }) {
  return (
    <>
      <Link
        className="font-medium wrap-anywhere hover:underline"
        params={{ name: job.system }}
        search={{ tab: 'records' }}
        to="/systems/$name"
      >
        {job.name}
      </Link>
      {withSystem && <span className="ml-2 text-xs text-muted-foreground">{job.system}</span>}
      <span className="block text-xs text-muted-foreground">
        {scheduleWords(job.schedule)}
        {job.scheduler === '' ? '' : ` · ${job.scheduler}`}
      </span>
    </>
  );
}

function LatestRun({ job, now }: { job: JobsRow; now: number }) {
  const words = latestRunWords(job, now);
  return (
    <span
      className={cn(
        job.latestRun !== undefined && job.latestRun.exitStatus !== 0 && MARK_COLOR.alert,
      )}
    >
      {words === undefined ? 'not run yet' : <PhraseText phrase={words} />}
    </span>
  );
}

const HEAD = 'px-3 py-3 text-xs font-medium text-muted-foreground';

// Every job as a table on a wide screen, in the order given.
function JobsTable({ jobs, now }: { jobs: readonly JobsRow[]; now: number }) {
  return (
    <table className="hidden w-full border-collapse text-left text-sm md:table">
      <thead>
        <tr className="border-b">
          <th className={cn(HEAD, 'w-24')} scope="col">
            <span className="sr-only">Level</span>
          </th>
          <th className={HEAD} scope="col">
            Job
          </th>
          <th className={HEAD} scope="col">
            System
          </th>
          <th className={HEAD} scope="col">
            Last 14 runs
          </th>
          <th className={HEAD} scope="col">
            Latest run
          </th>
          <th className={HEAD} scope="col">
            Next due
          </th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr
            className="border-b border-border/60 align-top"
            data-state={job.state}
            key={jobKey(job)}
          >
            <td className="px-3 py-3.5">
              <Level job={job} />
            </td>
            <td className="px-3 py-3">
              <JobName job={job} />
            </td>
            <td className="px-3 py-3.5 text-muted-foreground">{job.system}</td>
            <td className="px-3 py-3.5">
              <Strip cells={job.strip} />
            </td>
            <td className="px-3 py-3.5 tabular-nums">
              <LatestRun job={job} now={now} />
            </td>
            <td
              className={cn(
                'px-3 py-3.5 tabular-nums',
                job.state === 'overdue' ? MARK_COLOR.warning : 'text-muted-foreground',
              )}
            >
              <PhraseText phrase={dueWords(job, now)} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Every job as a card on a phone: its name, System, and level, its strip, and
// when it is next due.
function JobCards({ jobs, now }: { jobs: readonly JobsRow[]; now: number }) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {jobs.map((job) => (
        <li
          className="card-surface rounded-xl border px-4 py-3"
          data-state={job.state}
          key={jobKey(job)}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0">
              <JobName job={job} withSystem />
            </p>
            <Level job={job} />
          </div>
          <div className="mt-2">
            <Strip cells={job.strip} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground tabular-nums">
            Latest: <LatestRun job={job} now={now} />
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            Next: <PhraseText phrase={dueWords(job, now)} />
          </p>
        </li>
      ))}
    </ul>
  );
}

const legendKey = (kind: StripCell['kind'], label: string): ReactNode => (
  <span className="inline-flex items-center gap-1.5">
    <span aria-hidden="true" className={cn('h-3 w-1.5 rounded-[2px]', CELL[kind])} />
    {label}
  </span>
);

function Legend() {
  return (
    <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {legendKey('ok', 'succeeded')}
      {legendKey('failed', 'failed')}
      {legendKey('missed', 'missed: no run within the grace period')}
    </p>
  );
}

// The Jobs page's list: a table on a wide screen and cards on a phone.
export function JobsList({ jobs, now }: { jobs: readonly JobsRow[]; now: number }) {
  return (
    <>
      <div className="md:card-surface md:rounded-xl md:border md:px-2 md:py-2">
        <JobsTable jobs={jobs} now={now} />
        <JobCards jobs={jobs} now={now} />
        <div className="md:px-3 md:pb-2">
          <Legend />
        </div>
      </div>
    </>
  );
}
