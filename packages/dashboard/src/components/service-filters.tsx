import { filterServices, SERVICE_STATUS_FILTERS, serviceFilterCounts } from '../lib/services.ts';
import type { ServiceFilters, ServiceStatusFilter, ServiceSummary } from '../lib/services.ts';
import { ActiveFilters, FilterControl, FilterSheet, toggle } from './filter-sheet.tsx';

const STATUS_NAMES: Record<ServiceStatusFilter, string> = {
  down: 'Down',
  restarted: 'Restarted',
  unknown: 'Unknown',
  up: 'Up',
  updates: 'Updates',
};
const emptyFilters = (): ServiceFilters => ({ status: [], system: [] });
const isStatus = (value: string): value is ServiceStatusFilter =>
  SERVICE_STATUS_FILTERS.some((known) => known === value);

type FilterProps = { filters: ServiceFilters; onChange: (filters: ServiceFilters) => void };

const toggleIn = (filters: ServiceFilters, section: string, value: string): ServiceFilters => {
  if (section === 'status' && isStatus(value)) {
    return { ...filters, status: toggle(filters.status, value) };
  }
  return section === 'system' ? { ...filters, system: toggle(filters.system, value) } : filters;
};

const sheetFor = (rows: readonly ServiceSummary[], filters: ServiceFilters) => {
  const counts = serviceFilterCounts(rows, filters);
  return {
    sections: [
      {
        chips: SERVICE_STATUS_FILTERS.map((status) => ({
          count: counts.status[status],
          label: STATUS_NAMES[status],
          selected: filters.status.includes(status),
          value: status,
        })),
        key: 'status',
        title: 'Status',
      },
      {
        chips: Object.keys(counts.system)
          .toSorted((a, b) => a.localeCompare(b))
          .map((system) => ({
            count: counts.system[system] ?? 0,
            label: system,
            selected: filters.system.includes(system),
            value: system,
          })),
        key: 'system',
        title: 'System',
      },
    ],
    shown: filterServices(rows, filters).length,
  };
};

export function ActiveServiceFilters({ filters, onChange }: FilterProps) {
  return (
    <ActiveFilters
      onClear={() => onChange(emptyFilters())}
      pills={[
        ...filters.status.map((status) => ({
          key: `status:${status}`,
          label: STATUS_NAMES[status],
          remove: () => onChange({ ...filters, status: toggle(filters.status, status) }),
        })),
        ...filters.system.map((system) => ({
          key: `system:${system}`,
          label: system,
          remove: () => onChange({ ...filters, system: toggle(filters.system, system) }),
        })),
      ]}
    />
  );
}

export function ServiceFilterSheet({
  filters,
  onApply,
  onChange,
  onClose,
  open,
  rows,
}: FilterProps & {
  onApply: () => void;
  onClose: () => void;
  open: boolean;
  rows: readonly ServiceSummary[];
}) {
  return (
    <FilterSheet
      {...sheetFor(rows, filters)}
      noun="Services"
      onApply={onApply}
      onClear={() => onChange(emptyFilters())}
      onClose={onClose}
      onToggle={(section, value) => onChange(toggleIn(filters, section, value))}
      open={open}
      title="Filter Services"
      titleId="service-filter-title"
    />
  );
}

export function ServicesFilters({
  filters,
  onChange,
  rows,
}: FilterProps & { rows: readonly ServiceSummary[] }) {
  return (
    <FilterControl
      activeCount={filters.status.length + filters.system.length}
      empty={emptyFilters}
      filters={filters}
      noun="Services"
      onChange={onChange}
      sheetFor={(draft) => sheetFor(rows, draft)}
      title="Filter Services"
      titleId="service-filter-title"
      toggleIn={toggleIn}
    />
  );
}
