// The dashboard's sections, in the top bar's order. Activity is the Fleet
// Timeline.
export const SECTIONS = [
  { key: 'home', label: 'Home' },
  { key: 'systems', label: 'Systems' },
  { key: 'services', label: 'Services' },
  { key: 'agents', label: 'Agents' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'activity', label: 'Activity' },
] as const;

export type Section = (typeof SECTIONS)[number]['key'];

// The phone's bottom bar: Systems and Maintenance live under More.
export const PHONE_TABS = [
  { key: 'home', label: 'Home' },
  { key: 'services', label: 'Services' },
  { key: 'agents', label: 'Agents' },
  { key: 'activity', label: 'Activity' },
  { key: 'more', label: 'More' },
] as const;

export type PhoneTab = (typeof PHONE_TABS)[number]['key'];

// The Services filter for Services with an update, which a System's page opens.
export const MAINTENANCE_STATUS = ['updates'] as const;

// The section a page belongs to: a System or Condition page to Systems, a
// Service page to Services, a Session page to Agents, the Maintenance page to
// Maintenance, and Compare to Home.
// The More page and unknown paths belong to none.
export const sectionOf = (path: string): Section | undefined => {
  const parts = path.split('/').filter((part) => part !== '');
  const [first, , kind] = parts;
  if (first === undefined || first === 'compare') {
    return 'home';
  }
  if (first === 'systems') {
    if (kind === 'services') {
      return 'services';
    }
    return kind === 'sessions' ? 'agents' : 'systems';
  }
  if (first === 'services') {
    return 'services';
  }
  if (first === 'agents') {
    return 'agents';
  }
  if (first === 'maintenance') {
    return 'maintenance';
  }
  return first === 'activity' ? 'activity' : undefined;
};

// The bottom-bar tab a page belongs to: its section's own tab, else More,
// which holds Systems, Maintenance, and the More page itself.
export const phoneTabOf = (path: string): PhoneTab | undefined => {
  const section = sectionOf(path);
  if (section === 'systems' || section === 'maintenance' || path.replace(/\/$/u, '') === '/more') {
    return 'more';
  }
  return section;
};
