import type { StatsFs } from 'node:fs';

import type { VitalsSample } from '@heimdall/schema';

export type Disk = VitalsSample['disks'][number];

// Block-device filesystems that are read-only media, not storage that fills up.
const READ_ONLY_MEDIA = new Set(['iso9660', 'squashfs', 'udf']);

// /proc/self/mounts escapes space, tab, newline, and backslash as octal.
const unescapeMount = (field: string) =>
  field.replaceAll(/\\([0-7]{3})/gu, (_, octal: string) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );

// The storage a mount draws on: its block device, or for ZFS its pool, whose
// datasets share one pool of free space. Undefined for virtual filesystems.
const storageOf = (source: string, fsType: string): string | undefined => {
  if (fsType === 'zfs') {
    return `zfs:${source.split('/')[0] ?? source}`;
  }
  return source.startsWith('/dev/') && !READ_ONLY_MEDIA.has(fsType) ? source : undefined;
};

// Linux mount points worth reporting, from /proc/self/mounts: local block-device
// filesystems and ZFS pools, each once at its first mount so bind mounts and
// sibling datasets do not repeat it.
export const linuxMounts = (mounts: string): string[] => {
  const storage = new Map<string, string>();
  for (const line of mounts.split('\n')) {
    const [source, mountPoint, fsType] = line.split(' ');
    if (source === undefined || mountPoint === undefined || fsType === undefined) {
      continue;
    }
    const key = storageOf(source, fsType);
    if (key !== undefined && !storage.has(key)) {
      storage.set(key, unescapeMount(mountPoint));
    }
  }
  return [...storage.values()];
};

const DARWIN_MOUNT = /^(\S+) on (.+) \(([^)]*)\)$/u;

// macOS mount points worth reporting, from `mount` output. The sealed system
// volume and its siblings under /System/Volumes are fixed size, so only the Data
// volume and writable local volumes under /Volumes count.
export const darwinMounts = (mountOutput: string): string[] =>
  mountOutput.split('\n').flatMap((line) => {
    const [, source, mountPoint, flagList] = DARWIN_MOUNT.exec(line) ?? [];
    if (source === undefined || mountPoint === undefined || flagList === undefined) {
      return [];
    }
    const flags = flagList.split(', ');
    const local = source.startsWith('/dev/') && flags.includes('local');
    const writable = !flags.includes('read-only');
    const reported = mountPoint === '/System/Volumes/Data' || mountPoint.startsWith('/Volumes/');
    return local && writable && reported ? [mountPoint] : [];
  });

// A mount's size and use from statfs. Used counts every block not free, so blocks
// reserved for root count as used, as `df` reports them.
export const diskUsage = (
  mount: string,
  stat: Pick<StatsFs, 'bfree' | 'blocks' | 'bsize'>,
): Disk => ({
  mount,
  totalBytes: stat.blocks * stat.bsize,
  usedBytes: (stat.blocks - stat.bfree) * stat.bsize,
});
