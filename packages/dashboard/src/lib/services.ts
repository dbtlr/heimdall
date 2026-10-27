export const SERVICE_STATUSES = ['down', 'restarted', 'up', 'unknown'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export type ServiceSummary = {
  downSince: number | undefined;
  latestStopAt: number | undefined;
  name: string;
  status: ServiceStatus;
  system: string;
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

export type ServiceFilters = { status: ServiceStatus[]; system: string[] };

const strings = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return [value];
  }
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : [];
};

export const servicesSearch = (search: { status?: unknown; system?: unknown }) => {
  const status = strings(search.status).filter((value): value is ServiceStatus =>
    SERVICE_STATUSES.some((known) => known === value),
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

export const sortServices = (rows: readonly ServiceSummary[]): ServiceSummary[] =>
  rows.toSorted(
    (a, b) =>
      SERVICE_STATUSES.indexOf(a.status) - SERVICE_STATUSES.indexOf(b.status) ||
      a.name.localeCompare(b.name) ||
      a.system.localeCompare(b.system),
  );

export const filterServices = (
  rows: readonly ServiceSummary[],
  filters: ServiceFilters,
): ServiceSummary[] =>
  rows.filter(
    ({ status, system }) =>
      (filters.status.length === 0 || filters.status.includes(status)) &&
      (filters.system.length === 0 || filters.system.includes(system)),
  );

// Each section's counts describe a chip on its own, constrained only by the other section.
export const serviceFilterCounts = (rows: readonly ServiceSummary[], filters: ServiceFilters) => {
  const status: Record<ServiceStatus, number> = { down: 0, restarted: 0, unknown: 0, up: 0 };
  const system = Object.fromEntries(rows.map((row) => [row.system, 0]));
  for (const row of rows) {
    if (filters.system.length === 0 || filters.system.includes(row.system)) {
      status[row.status] += 1;
    }
    if (filters.status.length === 0 || filters.status.includes(row.status)) {
      system[row.system] = (system[row.system] ?? 0) + 1;
    }
  }
  return { status, system };
};
