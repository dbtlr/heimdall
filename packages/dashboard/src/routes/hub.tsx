import { createFileRoute, Link } from '@tanstack/react-router';

import { HubStatusContent } from '../components/hub-status.tsx';
import { contentFrame } from '../lib/layout.ts';
import { getHubStatus } from '../server/hub-status-fn.ts';

export const Route = createFileRoute('/hub')({
  component: Hub,
  loader: () => getHubStatus(),
});

function Hub() {
  return (
    <main className={`${contentFrame('wide')} pb-8`}>
      <Link className="mt-4 block text-sm text-link sm:hidden" to="/more">
        ‹ More
      </Link>
      <HubStatusContent status={Route.useLoaderData()} />
    </main>
  );
}
