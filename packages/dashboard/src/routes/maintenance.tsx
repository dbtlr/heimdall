import { createFileRoute } from '@tanstack/react-router';

import { MaintenanceCards } from '../components/maintenance-cards.tsx';
import { contentFrame } from '../lib/layout.ts';
import { getMaintenance } from '../server/maintenance-fn.ts';

export const Route = createFileRoute('/maintenance')({
  component: MaintenancePage,
  loader: () => getMaintenance(),
});

// What can wait on each paired System: pending packages with security updates
// first, a pending reboot, and Services with an update.
function MaintenancePage() {
  const maintenance = Route.useLoaderData();
  return (
    <main className={`${contentFrame('wide')} pb-8`}>
      <h1 className="pt-5 pb-1 text-[24px] font-semibold sm:pt-6 sm:text-[28px]">Maintenance</h1>
      <MaintenanceCards maintenance={maintenance} />
    </main>
  );
}
