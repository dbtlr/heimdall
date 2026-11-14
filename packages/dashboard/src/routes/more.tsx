import { createFileRoute, Link, useLoaderData } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { MARK_COLOR } from '../components/attention-status.tsx';
import { ConditionGlyph } from '../components/condition-glyph.tsx';
import { JumpBox } from '../components/jump-box.tsx';
import type { FleetSummary } from '../lib/fleet.ts';
import { contentFrame } from '../lib/layout.ts';
import { getJumpIndex } from '../server/jump-index-fn.ts';
import { DASHBOARD_VERSION } from '../version.ts';

export const Route = createFileRoute('/more')({ component: More });

const ROW = 'flex min-h-13 items-center justify-between gap-3 px-4 py-2';

function RowLink({ children, label }: { children?: ReactNode; label: string }) {
  return (
    <>
      <span className="font-semibold">{label}</span>
      <span className="flex items-center gap-1 text-sm text-muted-foreground">
        {children}
        <ChevronRight aria-hidden="true" className="size-4" />
      </span>
    </>
  );
}

// The Systems row's summary: the worst open level that asks for action with
// its count, and how many Systems are paired.
function SystemsSummary({ fleet }: { fleet: FleetSummary }) {
  const { worst } = fleet;
  return (
    <>
      {worst !== undefined && (
        <span className={`flex items-center gap-1 font-semibold ${MARK_COLOR[worst]}`}>
          <ConditionGlyph kind={worst} />
          {fleet.counts[worst]}
          <span className="sr-only">{worst === 'alert' ? ' alert' : ' warning'}</span>
          <span aria-hidden="true" className="font-normal text-muted-foreground">
            ·
          </span>
        </span>
      )}
      {fleet.systems} {fleet.systems === 1 ? 'System' : 'Systems'}
    </>
  );
}

// The phone's More tab: the sections the bottom bar has no room for, the jump
// box, and the dashboard's version.
function More() {
  const { fleet } = useLoaderData({ from: '__root__' });
  return (
    <main className={`${contentFrame('narrow')} pb-8`}>
      <h1 className="pt-5 pb-4 text-[24px] font-semibold sm:pt-6 sm:text-[28px]">More</h1>
      <ul className="divide-y rounded-xl border card-surface">
        <li>
          <Link className={ROW} to="/systems">
            <RowLink label="Systems">
              {fleet !== undefined && <SystemsSummary fleet={fleet} />}
            </RowLink>
          </Link>
        </li>
        <li>
          <Link className={ROW} to="/jobs">
            <RowLink label="Jobs">Runs, failures, and when each is next due</RowLink>
          </Link>
        </li>
        <li>
          <Link className={ROW} to="/maintenance">
            <RowLink label="Maintenance">Packages, reboots, and Service updates</RowLink>
          </Link>
        </li>
        <li className="flex flex-col gap-2 px-4 py-3">
          <span className="font-semibold">Jump to</span>
          <JumpBox loadIndex={() => getJumpIndex()} wide />
        </li>
        <li className={ROW}>
          <span className="font-semibold">Version</span>
          <span className="text-sm text-muted-foreground">v{DASHBOARD_VERSION}</span>
        </li>
      </ul>
    </main>
  );
}
