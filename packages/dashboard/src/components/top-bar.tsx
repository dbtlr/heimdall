import { Link, useRouterState } from '@tanstack/react-router';

import type { FleetSummary } from '../lib/fleet.ts';
import { contentFrame } from '../lib/layout.ts';
import { MAINTENANCE_STATUS, sectionOf, SECTIONS } from '../lib/sections.ts';
import type { Section } from '../lib/sections.ts';
import { cn } from '../lib/utils.ts';
import type { JumpIndex } from '../server/jump-index-types.ts';
import { ServicesBadge } from './app-navigation.tsx';
import { FleetVerdict } from './fleet-verdict.tsx';
import { JumpBox } from './jump-box.tsx';

const SECTION_PATHS: Record<
  Exclude<Section, 'maintenance'>,
  '/' | '/agents' | '/services' | '/systems' | '/timeline'
> = {
  activity: '/timeline',
  agents: '/agents',
  home: '/',
  services: '/services',
  systems: '/systems',
};

function SectionLink({
  current,
  label,
  section,
}: {
  current: boolean;
  label: string;
  section: Section;
}) {
  // The router would also mark any link the location starts with; only an
  // exact match may agree with `current`, so the section alone is marked.
  const shared = {
    activeOptions: { exact: true },
    'aria-current': current ? ('page' as const) : undefined,
    className: cn(
      'flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[15px] text-muted-foreground hover:text-foreground',
      current && 'bg-secondary font-semibold text-foreground',
    ),
  };
  const content = (
    <>
      {label}
      {section === 'services' && <ServicesBadge />}
    </>
  );
  return section === 'maintenance' ? (
    <Link {...shared} search={{ status: [...MAINTENANCE_STATUS] }} to="/services">
      {content}
    </Link>
  ) : (
    <Link {...shared} to={SECTION_PATHS[section]}>
      {content}
    </Link>
  );
}

// The bar across the top of every page: the name and the fleet verdict, and
// from `sm` up the sections, with the one the page belongs to marked, and the
// jump box, which a bare `/` focuses. Below `lg` the sections take a row of
// their own. Without a fleet summary (its read failed) the verdict is left out.
// `loadJumpIndex` reads the jump box's names.
export function TopBar({
  fleet,
  loadJumpIndex,
}: {
  fleet: FleetSummary | undefined;
  loadJumpIndex: () => Promise<JumpIndex>;
}) {
  const location = useRouterState({ select: (state) => state.location });
  const active = sectionOf(location.pathname, location.search);
  return (
    <header className="border-b bg-bar pt-[env(safe-area-inset-top)]">
      <div
        className={cn(
          contentFrame('wide'),
          'flex min-h-[50px] flex-wrap items-center gap-x-3.5 py-2 lg:flex-nowrap',
        )}
      >
        <span className="text-lg font-bold tracking-[0.02em] sm:text-base">Heimdall</span>
        <nav
          aria-label="Main navigation"
          className="order-last -mx-2.5 hidden basis-full gap-0.5 overflow-x-auto pt-1 sm:flex lg:order-none lg:mx-0 lg:basis-auto lg:pt-0"
        >
          {SECTIONS.map(({ key, label }) => (
            <SectionLink current={active === key} key={key} label={label} section={key} />
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3.5">
          {fleet?.verdictShown === true && <FleetVerdict counts={fleet.counts} />}
          <div className="hidden sm:block">
            <JumpBox loadIndex={loadJumpIndex} shortcut />
          </div>
        </div>
      </div>
    </header>
  );
}
