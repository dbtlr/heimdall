export const SERVICE_STATUSES = ['down', 'restarted', 'up', 'unknown'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];
export const SERVICE_STATUS_FILTERS = ['down', 'restarted', 'updates', 'up', 'unknown'] as const;
export type ServiceStatusFilter = (typeof SERVICE_STATUS_FILTERS)[number];

export type ServiceSummary = {
  downSince: number | undefined;
  latestStopAt: number | undefined;
  name: string;
  status: ServiceStatus;
  system: string;
  // The installed version the Hub derived, null while unknown.
  version: string | null;
  update: string | undefined;
};

// Stored Conditions take precedence; checks alone establish up only when all pass.
export const serviceStatus = ({
  checks,
  downSince,
  restarted,
}: {
  checks: readonly { state: string }[];
  downSince: number | undefined;
  restarted: boolean;
}): ServiceStatus => {
  if (downSince !== undefined) {
    return 'down';
  }
  if (restarted) {
    return 'restarted';
  }
  return checks.length > 0 && checks.every(({ state }) => state === 'up') ? 'up' : 'unknown';
};

export type ServiceFilters = { status: ServiceStatusFilter[]; system: string[] };

const strings = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return [value];
  }
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : [];
};

export const servicesSearch = (search: { status?: unknown; system?: unknown }) => {
  const status = strings(search.status).filter((value): value is ServiceStatusFilter =>
    SERVICE_STATUS_FILTERS.some((known) => known === value),
  );
  const system = strings(
    typeof search.system === 'number' && Number.isFinite(search.system)
      ? String(search.system)
      : search.system,
  );
  return {
    status: status.length > 0 ? status : undefined,
    system: system.length > 0 ? system : undefined,
  };
};

const sortRank = (row: ServiceSummary) => {
  if (row.status === 'down') {
    return 0;
  }
  if (row.status === 'restarted') {
    return 1;
  }
  if (row.update !== undefined) {
    return 2;
  }
  return row.status === 'up' ? 3 : 4;
};

const matchesStatus = (row: ServiceSummary, statuses: readonly ServiceStatusFilter[]) =>
  statuses.length === 0 ||
  statuses.some((status) =>
    status === 'updates' ? row.update !== undefined : row.status === status,
  );

export const sortServices = (rows: readonly ServiceSummary[]): ServiceSummary[] =>
  rows.toSorted(
    (a, b) =>
      sortRank(a) - sortRank(b) || a.name.localeCompare(b.name) || a.system.localeCompare(b.system),
  );

export const filterServices = (
  rows: readonly ServiceSummary[],
  filters: ServiceFilters,
): ServiceSummary[] =>
  rows.filter(
    (row) =>
      matchesStatus(row, filters.status) &&
      (filters.system.length === 0 || filters.system.includes(row.system)),
  );

// Each section's counts describe a chip on its own, constrained only by the other section.
export const serviceFilterCounts = (rows: readonly ServiceSummary[], filters: ServiceFilters) => {
  const status: Record<ServiceStatusFilter, number> = {
    down: 0,
    restarted: 0,
    unknown: 0,
    up: 0,
    updates: 0,
  };
  const system = Object.fromEntries(rows.map((row) => [row.system, 0]));
  for (const row of rows) {
    if (filters.system.length === 0 || filters.system.includes(row.system)) {
      status[row.status] += 1;
      if (row.update !== undefined) {
        status.updates += 1;
      }
    }
    if (matchesStatus(row, filters.status)) {
      system[row.system] = (system[row.system] ?? 0) + 1;
    }
  }
  return { status, system };
};
