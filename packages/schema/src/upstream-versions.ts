import type { UpdateManager } from './updates-section.ts';
import { freshUpdateTime, UPDATE_METADATA_MAX_AGE_MS } from './updates-section.ts';

// The numeric core and channel identifiers used by loose semver comparisons.
export type ParsedVersion = {
  core: readonly number[];
  label: string | null;
  rest: readonly string[];
};

// Reads a release without treating moving tags or malformed versions as numbers.
export const parseVersion = (text: string): ParsedVersion | undefined => {
  if (/\s/u.test(text)) {
    return undefined;
  }
  const version = text.split('+')[0] ?? '';
  const match = /^[vV]?(\d+(?:\.\d+)*)(?:-([\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?$/u.exec(version);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const core = match[1].split('.').map(Number);
  // A number too large to compare exactly is no version number, and nor is
  // a lone number of more than four digits: a date, a build number, or a
  // commit hash made only of digits.
  if (!core.every(Number.isSafeInteger) || (core.length === 1 && match[1].length > 4)) {
    return undefined;
  }
  const [label, ...rest] = match[2]?.split('.') ?? [];
  return { core, label: label ?? null, rest };
};

const compareCores = (left: ParsedVersion, right: ParsedVersion) => {
  for (let index = 0; index < Math.max(left.core.length, right.core.length); index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

const compareVersions = (left: ParsedVersion, right: ParsedVersion) => {
  const core = compareCores(left, right);
  if (core !== 0) {
    return core;
  }
  for (let index = 0; index < Math.max(left.rest.length, right.rest.length); index += 1) {
    const a = left.rest[index];
    const b = right.rest[index];
    if (a === undefined || b === undefined) {
      return a === undefined ? -1 : 1;
    }
    const numericA = /^\d+$/u.test(a);
    const numericB = /^\d+$/u.test(b);
    if (numericA && numericB) {
      const numberA = BigInt(a);
      const numberB = BigInt(b);
      if (numberA !== numberB) {
        return numberA < numberB ? -1 : 1;
      }
    } else if (numericA !== numericB) {
      return numericA ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
};

// Keeps the first original release string at the highest precedence per channel.
export const newestPerChannel = (releases: Iterable<string>): Record<string, string> => {
  const newest = new Map<string, { parsed: ParsedVersion; text: string }>();
  for (const text of releases) {
    const parsed = parseVersion(text);
    if (parsed === undefined) {
      continue;
    }
    const channel = parsed.label ?? '';
    const previous = newest.get(channel);
    if (previous === undefined || compareVersions(parsed, previous.parsed) > 0) {
      newest.set(channel, { parsed, text });
    }
  }
  return Object.fromEntries([...newest].map(([channel, release]) => [channel, release.text]));
};

// A comparison distinguishes a matched release from missing upstream knowledge.
export type UpdateStatus =
  | { kind: 'unreadable' }
  | { kind: 'update'; version: string }
  | { kind: 'current' }
  | { kind: 'unknown' };

// Finds a newer own-channel release or a strictly newer unlabelled numeric core.
export const availableUpdate = (
  installed: string | null,
  newest: Readonly<Record<string, string>>,
): UpdateStatus => {
  const parsed = installed === null ? undefined : parseVersion(installed);
  if (parsed === undefined) {
    return { kind: 'unreadable' };
  }
  const channel = parsed.label ?? '';
  const ownText = Object.hasOwn(newest, channel) ? newest[channel] : undefined;
  const own = ownText === undefined ? undefined : parseVersion(ownText);
  let candidate =
    own !== undefined && ownText !== undefined && compareVersions(own, parsed) > 0
      ? { parsed: own, text: ownText }
      : undefined;
  if (parsed.label !== null) {
    const plainText = Object.hasOwn(newest, '') ? newest[''] : undefined;
    const plain = plainText === undefined ? undefined : parseVersion(plainText);
    if (
      plain !== undefined &&
      plainText !== undefined &&
      compareCores(plain, parsed) > 0 &&
      (candidate === undefined || compareCores(plain, candidate.parsed) > 0)
    ) {
      candidate = { parsed: plain, text: plainText };
    }
  }
  if (candidate !== undefined) {
    return { kind: 'update', version: candidate.text };
  }
  return { kind: own !== undefined && compareVersions(own, parsed) === 0 ? 'current' : 'unknown' };
};

const packageManager = (upstream: string) => {
  if (upstream.startsWith('apt:')) {
    return 'apt';
  }
  return upstream.startsWith('brew:') ? 'homebrew' : undefined;
};

// Matches an APT architecture or either Homebrew package kind to its upstream.
export const packageMatchesUpstream = (upstream: string, packageName: string): boolean => {
  const manager = packageManager(upstream);
  if (manager === 'apt') {
    const prefix = `${upstream.slice(4)}:`;
    return packageName.startsWith(prefix) && packageName.length > prefix.length;
  }
  if (manager === 'homebrew') {
    const name = upstream.slice(5);
    return packageName === `formula:${name}` || packageName === `cask:${name}`;
  }
  return false;
};

// Reads the first pending version covered by fresh package-manager metadata.
export const packageAvailableVersion = (
  upstream: string,
  observations: readonly UpdateManager[],
  now: number,
): string | null | undefined => {
  const manager = packageManager(upstream);
  if (manager === undefined) {
    return undefined;
  }
  for (const observation of observations) {
    if (
      observation.manager !== manager ||
      !freshUpdateTime(observation.observedAt, now) ||
      observation.result.kind !== 'available' ||
      observation.result.metadataAt === null ||
      !freshUpdateTime(observation.result.metadataAt, now, UPDATE_METADATA_MAX_AGE_MS)
    ) {
      continue;
    }
    const match = observation.result.updates.find(({ name }) =>
      packageMatchesUpstream(upstream, name),
    );
    if (match !== undefined) {
      return match.available;
    }
  }
  return null;
};
