import type { ListedService } from '../server/system-detail-types.ts';

// A Service's installed version as the Hub derived it, or a muted "unknown"
// when it could not.
export function InstalledVersion({ version }: { version: string | null }) {
  return version ?? <span className="text-muted-foreground">unknown</span>;
}

// A Service's installed version and, when one is offered, the update to it in
// the violet accent tag. A long version, such as an image digest, wraps inside
// a narrow card.
export function ServiceVersion({
  service,
}: {
  service: Pick<ListedService, 'update' | 'version'>;
}) {
  const { update, version } = service;
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <span className="font-mono text-xs wrap-anywhere text-muted-foreground tabular-nums">
        <InstalledVersion version={version} />
      </span>
      {update !== undefined && (
        <span
          className="rounded-md bg-select/15 px-1.5 font-mono text-xs wrap-anywhere text-select tabular-nums"
          data-update={update}
        >
          → {update}
        </span>
      )}
    </span>
  );
}
