import type { ServiceDetail } from '../server/service-detail-types.ts';

// The installed version under the status line, with its upstream when known,
// and the Application the Service names when it is not recorded.
export function InstalledLine({ installed }: { installed: ServiceDetail['installed'] }) {
  const { missingApplication, upstream, version } = installed;
  return (
    <p className="mt-1 text-sm text-muted-foreground wrap-anywhere">
      {version === null ? 'Installed version unknown' : `Installed ${version}`}
      {version !== null && upstream !== null && ` · ${upstream}`}
      {missingApplication !== undefined &&
        ` · names Application ${missingApplication}, which is not recorded`}
    </p>
  );
}
