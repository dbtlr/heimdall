// How a package reads on Maintenance. The stored name is the manager's full
// identity (`formula:git`, `openssl:amd64`); people know the short one.

const BREW_NAME = /^(formula|cask):(.+)$/u;

// What APT calls a package built for every architecture. dpkg leaves it out
// of the names it shows, and it says nothing of the System's own.
const ANY_ARCHITECTURE = 'all';

// The text after the last colon of an APT name, which is its architecture.
const architectureOf = (name: string): string | undefined => {
  const at = name.lastIndexOf(':');
  return at > 0 && at < name.length - 1 ? name.slice(at + 1) : undefined;
};

// The architecture most of `names` carry, taken as the System's own: a
// multiarch System lists foreign packages too, but fewer of them. Homebrew
// names have a kind prefix, not an architecture, and `all` is no System's
// architecture, so neither counts.
export const ownArchitecture = (names: readonly string[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const name of names) {
    const arch = BREW_NAME.test(name) ? undefined : architectureOf(name);
    if (arch !== undefined && arch !== ANY_ARCHITECTURE) {
      counts.set(arch, (counts.get(arch) ?? 0) + 1);
    }
  }
  return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
};

// The short name of a package, and whether it is a Homebrew cask: an APT name
// drops its architecture when it is the System's own or `all`. The caller
// keeps the full identity for a title.
export const packageLabel = (
  name: string,
  own: string | undefined,
): { cask: boolean; label: string } => {
  const brew = BREW_NAME.exec(name);
  if (brew !== null) {
    return { cask: brew[1] === 'cask', label: brew[2] ?? name };
  }
  const arch = architectureOf(name);
  if (arch !== undefined && (arch === own || arch === ANY_ARCHITECTURE)) {
    return { cask: false, label: name.slice(0, -(arch.length + 1)) };
  }
  return { cask: false, label: name };
};
