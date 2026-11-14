import { createFileRoute, Link } from '@tanstack/react-router';

import { DateTime, PhraseText } from '../components/date-time.tsx';
import { RECORD_DOT } from '../components/recorded-panel.tsx';
import { ServiceHistory } from '../components/service-history.tsx';
import { InstalledLine, UpdateLines } from '../components/service-installed.tsx';
import { ServicePanel } from '../components/service-panel.tsx';
import { AvailabilityCard, StopsTable } from '../components/service-stops.tsx';
import { VitalsWindowCard } from '../components/vitals-window.tsx';
import { contentFrame } from '../lib/layout.ts';
import { serviceLine } from '../lib/recorded.ts';
import { supervisorLine } from '../lib/service-detail.ts';
import { cn } from '../lib/utils.ts';
import { getServiceDetail } from '../server/service-detail-fn.ts';

export const Route = createFileRoute('/systems/$name_/services/$service')({
  component: ServicePage,
  loader: async ({
    deps,
    params,
  }: {
    deps: { stop: number | undefined };
    params: { name: string; service: string };
  }) => getServiceDetail({ data: { name: params.name, service: params.service, stop: deps.stop } }),
  // The selected stop is in the URL, so a link to it opens its Vitals.
  loaderDeps: ({ search }: { search: { stop?: number | undefined } }) => ({ stop: search.stop }),
  notFoundComponent: () => (
    <>
      <main className={`${contentFrame('narrow')} py-6`}>
        <p>The Hub holds no such Service.</p>
      </main>
    </>
  ),
  validateSearch: (search: Record<string, unknown>): { stop?: number } => {
    const stop = Number(search.stop);
    return search.stop !== undefined && Number.isSafeInteger(stop) ? { stop } : {};
  },
});

function ServicePage() {
  const detail = Route.useLoaderData();
  const { installed, now, recorded, selection, service, system, unit } = detail;
  const line = recorded === undefined ? undefined : serviceLine(recorded, now);
  const where = recorded === undefined ? undefined : supervisorLine(recorded.supervisor, unit);
  return (
    <>
      <main
        className={`${contentFrame('narrow')} pb-8 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-x-7`}
      >
        <div className="min-w-0">
          <Link className="flex min-h-11 items-center text-base text-primary" to="/services">
            ‹ Services
          </Link>
          <header className="min-w-0">
            <h1 className="text-2xl leading-tight font-semibold wrap-anywhere">{service}</h1>
            <p className="text-sm text-muted-foreground wrap-anywhere">
              <Link className="text-primary" params={{ name: system }} to="/systems/$name">
                {system}
              </Link>
              {where !== undefined && <> · {where}</>}
            </p>
          </header>
          {/* On a wide screen the side panel holds these. */}
          <div className="lg:hidden">
            {line !== undefined && (
              <p className="mt-3 flex items-baseline gap-2 text-sm text-muted-foreground">
                <span
                  className={cn('size-2 shrink-0 self-center rounded-full', RECORD_DOT[line.state])}
                />
                <span className="min-w-0 wrap-anywhere">
                  <PhraseText phrase={line.text} />
                </span>
              </p>
            )}
            <InstalledLine installed={installed} />
            <UpdateLines now={now} update={detail.update} />
          </div>
          <AvailabilityCard detail={detail} />
          <div className="mt-[14px] grid gap-[14px] xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:items-start">
            <StopsTable detail={detail} />
            {selection !== undefined && (
              <VitalsWindowCard
                shade={selection.span}
                title={
                  <>
                    Around the stop · <DateTime at={selection.span.from} format="dated" now={now} />
                  </>
                }
                vitals={selection.vitals}
              />
            )}
          </div>
          <ServiceHistory detail={detail} />
          <p className="mt-4 text-xs text-muted-foreground">
            Stop times use the System&apos;s clock. Version changes and upstream checks use the
            Hub&apos;s.
          </p>
        </div>
        <aside className="hidden lg:sticky lg:top-6 lg:block">
          <ServicePanel detail={detail} />
        </aside>
      </main>
    </>
  );
}
