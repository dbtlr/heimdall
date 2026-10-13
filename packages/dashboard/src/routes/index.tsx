import { createFileRoute } from '@tanstack/react-router';

import { relativeTime } from '../lib/relative-time.ts';
import { getPairedSystems } from '../server/paired-systems.ts';

export const Route = createFileRoute('/')({
  component: Systems,
  loader: () => getPairedSystems(),
});

function Systems() {
  const { now, systems } = Route.useLoaderData();
  return (
    <>
      <header className="border-b bg-card">
        <h1 className="mx-auto max-w-3xl px-4 py-3 text-xl font-bold tracking-wide">Heimdall</h1>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Systems</h2>
        {systems.length === 0 ? (
          <p className="text-muted-foreground">No System is paired.</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {systems.map((system) => (
              <li className="flex items-baseline justify-between gap-4 px-4 py-3" key={system.name}>
                <span className="min-w-0 truncate font-medium">{system.name}</span>
                <span className="shrink-0 text-sm text-muted-foreground">
                  {system.lastSeenAt === undefined
                    ? 'never seen'
                    : relativeTime(system.lastSeenAt, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
