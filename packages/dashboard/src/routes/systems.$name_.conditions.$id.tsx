import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo } from 'react';

import { AppHeader } from '../components/app-header.tsx';
import { ConditionDetailPanel } from '../components/condition-detail.tsx';
import { conditionDetailView } from '../lib/condition-detail.ts';
import { getConditionDetail } from '../server/condition-detail-fn.ts';

export const Route = createFileRoute('/systems/$name_/conditions/$id')({
  component: ConditionPage,
  loader: async ({ params }: { params: { id: string; name: string } }) => ({
    detail: await getConditionDetail({ data: { id: params.id, name: params.name } }),
    now: Date.now(),
  }),
  notFoundComponent: () => (
    <>
      <AppHeader />
      <main className="mx-auto max-w-[1200px] px-3.5 py-6 sm:px-[22px]">
        <p>The Hub holds no such Condition.</p>
      </main>
    </>
  ),
});

function ConditionPage() {
  const { detail, now } = Route.useLoaderData();
  const view = useMemo(() => conditionDetailView(detail, now), [detail, now]);
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-[720px] px-3.5 pb-8 sm:px-[22px]">
        <Link
          className="flex min-h-11 items-center text-base text-primary"
          params={{ name: detail.system }}
          to="/systems/$name"
        >
          ‹ {detail.system}
        </Link>
        <ConditionDetailPanel now={now} view={view} />
      </main>
    </>
  );
}
