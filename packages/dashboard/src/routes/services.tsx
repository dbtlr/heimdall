import { createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { AppHeader } from '../components/app-header.tsx';
import { ActiveServiceFilters, ServicesFilters } from '../components/service-filters.tsx';
import { ServicesTable } from '../components/services-table.tsx';
import { filterServices, servicesSearch } from '../lib/services.ts';
import type { ServiceFilters } from '../lib/services.ts';
import { getServices } from '../server/services-fn.ts';

export const Route = createFileRoute('/services')({
  component: ServicesPage,
  loader: () => getServices(),
  validateSearch: (search: { status?: unknown; system?: unknown } & SearchSchemaInput) =>
    servicesSearch(search),
});

function ServicesPage() {
  const { now, services } = Route.useLoaderData();
  const search = Route.useSearch();
  const filters = { status: search.status ?? [], system: search.system ?? [] };
  const navigate = Route.useNavigate();
  const rows = filterServices(services, filters);
  const change = (next: ServiceFilters) => {
    void navigate({
      resetScroll: false,
      search: {
        status: (next.status.length > 0 && next.status) || undefined,
        system: (next.system.length > 0 && next.system) || undefined,
      },
    });
  };
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-[720px] px-3.5 pb-8 sm:px-[22px]">
        <header className="flex items-center justify-between gap-3 py-5">
          <div>
            <h1 className="text-2xl font-semibold">Services</h1>
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {rows.length} of {services.length} Services
            </p>
          </div>
          <ServicesFilters filters={filters} onChange={change} rows={services} />
        </header>
        <ActiveServiceFilters filters={filters} onChange={change} />
        <ServicesTable now={now} rows={rows} />
        {rows.length === 0 && (
          <p className="py-8 text-center text-muted-foreground">
            {services.length === 0
              ? 'No recorded Service on a paired System.'
              : 'No Services match these filters.'}
          </p>
        )}
      </main>
    </>
  );
}
