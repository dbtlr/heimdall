import type { ListedService } from '../server/system-detail-types.ts';

// A Service's installed version and, when one is offered, the update to it in
// the violet accent tag. Nothing for a Service whose version is not known.
export function ServiceVersion({
  service,
}: {
  service: Pick<ListedService, 'update' | 'version'>;
}) {
  const { update, version } = service;
  if (version === null && update === undefined) {
    return null;
  }
  return (
    <span className="flex flex-none items-baseline gap-1.5">
      {version !== null && (
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{version}</span>
      )}
      {update !== undefined && (
        <span
          className="rounded-md bg-select/15 px-1.5 font-mono text-xs text-select tabular-nums"
          data-update={update}
        >
          → {update}
        </span>
      )}
    </span>
  );
}
