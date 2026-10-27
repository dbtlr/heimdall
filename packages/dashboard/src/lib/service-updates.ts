import { availableUpdate, newestPerChannel, packageAvailableVersion } from '@heimdall/schema';
import type { UpdateManager } from '@heimdall/schema';

import { WINDOW_DAYS } from './service-detail.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export const isCheckedUpstream = (upstream: string | null): boolean =>
  upstream !== null && /^(github|npm|oci):/u.test(upstream);

export const isPackageUpstream = (upstream: string | null): boolean =>
  upstream !== null && /^(apt|brew):/u.test(upstream);

export type UpstreamCheck = {
  checkedAt: number;
  failure: string | null;
  releases: Readonly<Record<string, string>> | null;
  succeededAt: number | null;
};
export type UpstreamRelease = { at: number; version: string };

export type ServiceUpdate = {
  failure: { at: number; reason: string; succeededAt: number | null } | undefined;
  status:
    | { kind: 'update'; since: number | undefined; source: 'upstream'; version: string }
    | { kind: 'update'; source: 'APT' | 'Homebrew'; version: string }
    | { kind: 'current' }
    | { kind: 'unreadable'; version: string }
    | undefined;
};

// A release is compared on the installed version's channel, including releases
// no longer listed when dating when an update first became available.
export const serviceUpdate = ({
  check,
  now,
  observations = [],
  releases = [],
  upstream,
  version,
}: {
  check?: UpstreamCheck | undefined;
  now: number;
  observations?: readonly UpdateManager[];
  releases?: readonly UpstreamRelease[];
  upstream: string | null;
  version: string | null;
}): ServiceUpdate => {
  let status: ServiceUpdate['status'];
  if (version !== null && upstream !== null && isPackageUpstream(upstream)) {
    const available = packageAvailableVersion(upstream, observations, now);
    return {
      failure: undefined,
      status:
        typeof available === 'string'
          ? {
              kind: 'update',
              source: upstream.startsWith('apt:') ? 'APT' : 'Homebrew',
              version: available,
            }
          : undefined,
    };
  }
  if (!isCheckedUpstream(upstream)) {
    return { failure: undefined, status };
  }
  if (version !== null) {
    const compared = availableUpdate(version, check?.releases ?? {});
    if (compared.kind === 'update') {
      const times = releases
        .filter(
          (release) =>
            availableUpdate(version, newestPerChannel([release.version])).kind === 'update',
        )
        .map(({ at }) => at);
      status = {
        ...compared,
        since: times.reduce<number | undefined>(
          (first, at) => (first === undefined ? at : Math.min(first, at)),
          undefined,
        ),
        source: 'upstream',
      };
    } else if (compared.kind === 'current') {
      status = compared;
    } else if (compared.kind === 'unreadable') {
      status = { ...compared, version };
    }
  }
  return {
    failure:
      check !== undefined && check.failure !== null
        ? { at: check.checkedAt, reason: check.failure, succeededAt: check.succeededAt }
        : undefined,
    status,
  };
};

// Releases of the current upstream become history only when they were newer
// than the latest known version installed then. Version rows are oldest first;
// later installs do not erase these rows.
export const updatesOf = ({
  now,
  releases,
  upstream,
  versions,
}: {
  now: number;
  releases: readonly UpstreamRelease[];
  upstream: string | null;
  versions: readonly { at: number; upstream: string | null; version: string | null }[];
}): UpstreamRelease[] => {
  if (!isCheckedUpstream(upstream)) {
    return [];
  }
  return releases
    .filter(({ at, version }) => {
      if (at < now - WINDOW_DAYS * DAY_MS || at > now) {
        return false;
      }
      const installed = versions.findLast((row) => row.at <= at && row.version !== null);
      return (
        installed !== undefined &&
        installed.upstream === upstream &&
        availableUpdate(installed.version, newestPerChannel([version])).kind === 'update'
      );
    })
    .toSorted((a, b) => b.at - a.at);
};
