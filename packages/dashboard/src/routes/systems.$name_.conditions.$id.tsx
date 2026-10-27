import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo } from 'react';

import { AppHeader } from '../components/app-header.tsx';
import { ConditionDetailPanel } from '../components/condition-detail.tsx';
import { conditionDetailView } from '../lib/condition-detail.ts';
import { contentFrame } from '../lib/layout.ts';
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
      <main className={`${contentFrame('wide')} py-6`}>
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
      <main className={`${contentFrame('narrow')} pb-8`}>
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
