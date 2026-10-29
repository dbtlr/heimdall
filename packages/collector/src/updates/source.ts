import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { MAX_UPDATES_SECTION_BYTES, UpdatesSectionSchema } from '@heimdall/schema';
import type { PendingUpdate, UpdateManager, UpdatesSection } from '@heimdall/schema';
import { every, readConfigSection } from '@heimdall/service';

import type { Log } from '../collector.ts';
import { describeError } from '../errors.ts';
import { runBoundedCommand } from '../subprocess.ts';
import { observeHomebrew } from './homebrew.ts';

export const UPDATES_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// Configuration is local to the Collector. Paths are explicit so tests and
// nonstandard package-manager installations use the same observation boundary.
export const parseUpdatesConfig = (value: unknown) => {
  const defaults = {
    apt: '/usr/bin/apt',
    aptListsDir: '/var/lib/apt/lists',
    dpkgQuery: '/usr/bin/dpkg-query',
    homebrewCacheDir: join(
      homedir(),
      process.platform === 'darwin' ? 'Library/Caches/Homebrew/api' : '.cache/Homebrew/api',
    ),
    homebrewPrefixes:
      process.platform === 'darwin'
        ? ['/opt/homebrew', '/usr/local']
        : ['/home/linuxbrew/.linuxbrew', join(homedir(), '.linuxbrew')],
    intervalHours: 6,
    osRelease: '/etc/os-release',
    rebootMarker: '/var/run/reboot-required',
  };
  if (value === undefined) {
    return defaults;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('updates must be a table');
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(defaults, key)) {
      throw new Error(`Unknown updates setting: ${key}`);
    }
  }
  const config = { ...defaults };
  if ('intervalHours' in value) {
    if (
      typeof value.intervalHours !== 'number' ||
      !Number.isFinite(value.intervalHours) ||
      value.intervalHours < 1 / 3600 ||
      value.intervalHours > 596
    ) {
      throw new Error('updates.intervalHours must be at least 1/3600 and at most 596');
    }
    config.intervalHours = value.intervalHours;
  }
  for (const key of [
    'apt',
    'aptListsDir',
    'dpkgQuery',
    'osRelease',
    'rebootMarker',
    'homebrewCacheDir',
  ] as const) {
    if (key in value) {
      const path: unknown = Reflect.get(value, key);
      if (typeof path !== 'string' || !isAbsolute(path) || Buffer.byteLength(path) > 512) {
        throw new Error(`updates.${key} must be an absolute path of at most 512 characters`);
      }
      config[key] = path;
    }
  }
  if ('homebrewPrefixes' in value) {
    const paths = value.homebrewPrefixes;
    if (
      !Array.isArray(paths) ||
      paths.length > 14 ||
      !paths.every(
        (path: unknown) =>
          typeof path === 'string' && isAbsolute(path) && Buffer.byteLength(path) <= 512,
      )
    ) {
      throw new Error('updates.homebrewPrefixes must list at most 14 absolute paths');
    }
    config.homebrewPrefixes = [...new Set(paths)];
  }
  return config;
};
export type UpdatesConfig = ReturnType<typeof parseUpdatesConfig>;
export type UpdatesSource = { latest: () => UpdatesSection | undefined };
export const readUpdatesConfig = async (options: {
  cwd: string;
  home: string;
  named: string | undefined;
}) =>
  parseUpdatesConfig(
    await readConfigSection({ ...options, binary: 'collector', section: 'updates' }),
  );

const readSmall = async (path: string) => {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FILE_BYTES) {
      throw new Error('local metadata exceeds read budget');
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
};
const missing = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');
const unavailable = (reason: string) =>
  ({ kind: 'unavailable', reason: reason.slice(0, 1024) }) as const;

export const createUpdatesSource = ({
  config,
  platform,
  now,
  command = runBoundedCommand,
  signal,
}: {
  config: UpdatesConfig;
  platform: 'linux' | 'darwin';
  now: () => number;
  command?: typeof runBoundedCommand;
  signal?: AbortSignal;
}) => {
  let latest: UpdatesSection | undefined;
  let running: Promise<void> | undefined;
  const query = async (cmd: string[]) => {
    const result = await command(cmd, {
      env: { APT_CONFIG: '/dev/null', LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
      maxOutputBytes: MAX_FILE_BYTES,
      signal,
      timeoutMs: 30_000,
    });
    if (result.kind !== 'exited') {
      throw new Error(`command ${result.kind}`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`command exited ${String(result.exitCode)}`);
    }
    return result.stdout;
  };
  const observe = async () => {
    const observedAt = Math.trunc(now());
    const managers: UpdateManager[] = [];
    let debian = false;
    if (platform === 'linux') {
      try {
        const release = await readSmall(config.osRelease);
        debian = /^(?:ID|ID_LIKE)=["']?(?:[^\n"']*\s)?(?:debian|ubuntu)(?:\s|["']?$)/m.test(
          release,
        );
      } catch {
        /* Unknown OS cannot establish Debian marker semantics. */
      }
      if (debian) {
        const manager: UpdateManager = {
          installation: config.aptListsDir,
          manager: 'apt',
          observedAt,
          result: unavailable('APT observation has not completed'),
        };
        try {
          const census = await query([
            config.dpkgQuery,
            '-W',
            // oxlint-disable-next-line no-template-curly-in-string -- dpkg-query expands these fields.
            '-f=${db:Status-Status}\t${Package}\t${Architecture}\t${Version}\n',
          ]);
          const names: string[] = [];
          const versions: { name: string; version: string }[] = [];
          for (const line of census.split('\n').filter(Boolean)) {
            const [status, name, architecture, version, ...extra] = line.split('\t');
            if (
              !status ||
              !name ||
              !architecture ||
              !version ||
              extra.length > 0 ||
              !/^[a-z0-9][a-z0-9+.-]*$/.test(name) ||
              !/^[a-z0-9][a-z0-9-]*$/.test(architecture)
            ) {
              throw new Error('invalid dpkg census');
            }
            if (status === 'installed') {
              versions.push({ name: `${name}:${architecture}`, version });
            }
            switch (status) {
              case 'installed':
              case 'unpacked':
              case 'half-installed':
              case 'half-configured':
              case 'triggers-awaited':
              case 'triggers-pending': {
                names.push(`${name}:${architecture}`);
                break;
              }
              case 'not-installed':
              case 'config-files': {
                break;
              }
              default: {
                throw new Error('unknown dpkg installation status');
              }
            }
          }
          if (new Set(names).size !== names.length || names.length > 20000) {
            throw new Error('dpkg census exceeds limits');
          }
          manager.installed = { names, observedAt, versions };
        } catch {
          /* A failed census never proves that packages disappeared. */
        }
        try {
          const indexes = (await readdir(config.aptListsDir)).filter((name) =>
            /_Packages(?:\.(?:lz4|gz|xz|bz2))?$/.test(name),
          );
          if (indexes.length === 0) {
            throw new Error('APT has no local package indexes');
          }
          const metadata = await Promise.all(
            indexes.map((name) => stat(join(config.aptListsDir, name))),
          );
          if (metadata.some((file) => !file.isFile() || file.size === 0)) {
            throw new Error('APT package index is unusable');
          }
          // The indexes are read only to prove they are usable: apt stamps each with
          // its server's Last-Modified time, so one that rarely changes stays old.
          // The lists directory changes when apt commits any list file it
          // downloaded. Future timestamps are unknown.
          const refreshedAt = Math.trunc((await stat(config.aptListsDir)).mtimeMs);
          const output = await query([
            config.apt,
            '-o',
            `Dir::State::lists=${config.aptListsDir}`,
            'list',
            '--upgradable',
          ]);
          const updates: PendingUpdate[] = [];
          for (const line of output
            .split('\n')
            .filter((row) => row.trim() !== '' && !row.startsWith('Listing...'))) {
            const match =
              /^([^/\s]+)\/([^\s]+)\s+(\S+)\s+(\S+)\s+\[upgradable from: ([^\]]+)\]$/.exec(line);
            if (match === null) {
              throw new Error('unrecognized APT update output');
            }
            const [, name, suites, available, architecture, installed] = match;
            if (!name || !suites || !available || !architecture || !installed) {
              throw new Error('invalid APT update');
            }
            updates.push({
              available,
              installed,
              name: `${name}:${architecture}`,
              security: suites.split(',').some((suite) => /(?:^|-)security$/.test(suite))
                ? true
                : null,
            });
          }
          manager.result = {
            kind: 'available',
            metadataAt: refreshedAt >= 0 && refreshedAt <= observedAt ? refreshedAt : null,
            updates,
          };
        } catch (error) {
          manager.result = unavailable(describeError(error));
        }
        managers.push(manager);
      } else {
        managers.push({
          installation: config.aptListsDir,
          manager: 'apt',
          observedAt,
          result: unavailable('APT coverage requires a Debian-family OS'),
        });
      }
    }
    for (const prefix of config.homebrewPrefixes) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- Installation checks run sequentially to bound cache memory.
        await stat(join(prefix, 'bin', 'brew'));
        managers.push(
          // oxlint-disable-next-line no-await-in-loop -- Each installation owns a separately bounded cache read.
          await observeHomebrew({ cacheDir: config.homebrewCacheDir, observedAt, prefix }),
        );
      } catch (error) {
        managers.push({
          installation: prefix,
          manager: 'homebrew',
          observedAt,
          result: unavailable(
            missing(error)
              ? 'Homebrew executable is missing'
              : 'Homebrew ownership cannot be established',
          ),
        });
      }
    }
    if (platform === 'darwin') {
      managers.push({
        installation: 'system',
        manager: 'macos',
        observedAt,
        result: unavailable('No verified cache-only macOS Software Update query'),
      });
    }
    let reboot: UpdatesSection['reboot'] = {
      ...unavailable('Reboot marker is supported only on Debian-family systems'),
      observedAt,
    };
    if (debian) {
      try {
        await stat(config.rebootMarker);
        reboot = { kind: 'available', observedAt, required: true };
      } catch (error) {
        reboot = missing(error)
          ? { kind: 'available', observedAt, required: false }
          : { ...unavailable('Reboot marker cannot be read'), observedAt };
      }
    }
    let next: UpdatesSection = { managers, reboot };
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_UPDATES_SECTION_BYTES) {
      next = {
        managers: managers.map(({ installed: _installed, ...manager }) => ({
          ...manager,
          result: unavailable('Update observation exceeds section byte budget'),
        })),
        reboot,
      };
    }
    const parsed = UpdatesSectionSchema.safeParse(next);
    if (!parsed.success) {
      next = {
        managers: managers.map(({ installed: _installed, ...manager }) =>
          Object.assign(manager, {
            result: unavailable('Update observation exceeds schema limits'),
          }),
        ),
        reboot,
      };
    }
    if (!signal?.aborted) {
      latest = next;
    }
  };
  return {
    latest: () => latest,
    // Sharing the in-flight promise prevents concurrent callers overlapping checks.
    tick: () => {
      running ??= (async () => {
        try {
          await observe();
        } finally {
          running = undefined;
        }
      })();
      return running;
    },
  };
};

export const startUpdates = ({
  log,
  signal,
  ...options
}: Parameters<typeof createUpdatesSource>[0] & { log: Log }) => {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  const source = createUpdatesSource({ ...options, signal: controller.signal });
  const stop = every({
    intervalMs: options.config.intervalHours * 60 * 60_000,
    onError: (error) => log.warn(`Update observation failed: ${describeError(error)}`),
    task: source.tick,
  });
  return {
    latest: source.latest,
    stop: async () => {
      controller.abort();
      signal?.removeEventListener('abort', cancel);
      await stop();
    },
  };
};
