import { createFileRoute, Link } from '@tanstack/react-router';

import { AppHeader } from '../components/app-header.tsx';
import { PhraseText } from '../components/date-time.tsx';
import { StopList, StopsCard } from '../components/service-stops.tsx';
import { serviceLine } from '../lib/recorded.ts';
import type { RecordState } from '../lib/recorded.ts';
import { supervisorLine } from '../lib/service-detail.ts';
import { cn } from '../lib/utils.ts';
import { getServiceDetail } from '../server/service-detail-fn.ts';

const DOT: Record<RecordState, string> = {
  bad: 'bg-status-critical',
  good: 'bg-status-good',
  unknown: 'border-[1.5px] border-muted-foreground',
  warning: 'bg-status-warning',
};

export const Route = createFileRoute('/systems/$name_/services/$service')({
  component: ServicePage,
  loader: async ({ params }: { params: { name: string; service: string } }) =>
    getServiceDetail({ data: { name: params.name, service: params.service } }),
  notFoundComponent: () => (
    <>
      <AppHeader />
      <main className="mx-auto max-w-[720px] px-3.5 py-6 sm:px-[22px]">
        <p>The Hub holds no such Service.</p>
      </main>
    </>
  ),
});

function ServicePage() {
  const detail = Route.useLoaderData();
  const { now, recorded, service, system, unit } = detail;
  const line = recorded === undefined ? undefined : serviceLine(recorded, now);
  const where = recorded === undefined ? undefined : supervisorLine(recorded.supervisor, unit);
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-[720px] px-3.5 pb-8 sm:px-[22px]">
        <Link
          className="flex min-h-11 items-center text-base text-primary"
          params={{ name: system }}
          to="/systems/$name"
        >
          ‹ {system}
        </Link>
        <header className="min-w-0">
          <h1 className="text-2xl leading-tight font-semibold wrap-anywhere">{service}</h1>
          {where !== undefined && (
            <p className="text-sm text-muted-foreground wrap-anywhere">{where}</p>
          )}
        </header>
        {line !== undefined && (
          <p className="mt-3 flex items-baseline gap-2 text-sm text-muted-foreground">
            <span className={cn('size-2 shrink-0 self-center rounded-full', DOT[line.state])} />
            <span className="min-w-0 wrap-anywhere">
              <PhraseText phrase={line.text} />
            </span>
          </p>
        )}
        <StopsCard detail={detail} />
        <StopList detail={detail} />
        <p className="mt-4 text-xs text-muted-foreground">
          Times come from the System&apos;s clock; received times from the Hub&apos;s.
        </p>
      </main>
    </>
  );
}
