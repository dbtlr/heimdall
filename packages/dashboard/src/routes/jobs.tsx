import { createFileRoute } from '@tanstack/react-router';

import { JobsList } from '../components/jobs-list.tsx';
import { ServicesTabs } from '../components/services-tabs.tsx';
import { jobsSummary } from '../lib/jobs.ts';
import { contentFrame } from '../lib/layout.ts';
import { getJobs } from '../server/jobs-fn.ts';

export const Route = createFileRoute('/jobs')({
  component: JobsPage,
  loader: () => getJobs(),
});

// Every job a paired System's provisioner recorded, failing first, then
// overdue, with its last runs and when it is next due.
function JobsPage() {
  const { jobs, now } = Route.useLoaderData();
  return (
    <main className={`${contentFrame('wide')} pb-8`}>
      <ServicesTabs />
      <header className="py-4">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <p className="text-sm text-muted-foreground">{jobsSummary(jobs)}</p>
      </header>
      {jobs.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">
          No job is recorded on a paired System.
        </p>
      ) : (
        <JobsList jobs={jobs} now={now} />
      )}
    </main>
  );
}
