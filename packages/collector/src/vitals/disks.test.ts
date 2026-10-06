import { describe, expect, test } from 'bun:test';

import { darwinMounts, diskUsage, linuxMounts } from './disks.ts';

describe('Linux disks', () => {
  test('are the local block-device filesystems, one mount per device', () => {
    const mounts = [
      'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
      'udev /dev devtmpfs rw,nosuid,relatime 0 0',
      'tmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime 0 0',
      '/dev/vda4 / ext4 rw,relatime 0 0',
      '/dev/vda3 /boot ext4 rw,relatime 0 0',
      '/dev/vda2 /boot/efi vfat rw,relatime 0 0',
      '/dev/loop3 /snap/core22/2045 squashfs ro,nodev,relatime 0 0',
      '/dev/sr0 /media/cdrom iso9660 ro,relatime 0 0',
      'overlay /var/lib/docker/overlay2/x/merged overlay rw,relatime 0 0',
      '/dev/vda4 /var/lib/docker/bind ext4 rw,relatime 0 0',
      String.raw`/dev/sdb1 /mnt/backup\040drive btrfs rw,relatime 0 0`,
    ].join('\n');

    expect(linuxMounts(mounts)).toEqual(['/', '/boot', '/boot/efi', '/mnt/backup drive']);
  });
});

test('Linux disks include each ZFS pool once, at its first mount', () => {
  const mounts = [
    'rpool/ROOT/pve-1 / zfs rw,relatime,xattr,noacl 0 0',
    'rpool /rpool zfs rw,relatime,xattr,noacl 0 0',
    'rpool/data /rpool/data zfs rw,relatime,xattr,noacl 0 0',
    'tank/media /mnt/media zfs rw,relatime,xattr,noacl 0 0',
  ].join('\n');

  expect(linuxMounts(mounts)).toEqual(['/', '/mnt/media']);
});

describe('macOS disks', () => {
  test('are the Data volume and writable local volumes under /Volumes', () => {
    const mountOutput = [
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      'devfs on /dev (devfs, local, nobrowse)',
      '/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)',
      '/dev/disk3s2 on /System/Volumes/Preboot (apfs, local, journaled, nobrowse)',
      '/dev/disk3s4 on /System/Volumes/Update (apfs, local, journaled, nobrowse)',
      '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)',
      'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
      '/dev/disk5s1 on /Volumes/Backup Drive (apfs, local, nodev, nosuid, journaled, noowners)',
      '/dev/disk6s1 on /Volumes/Installer (hfs, local, nodev, nosuid, read-only, noowners)',
      '//drew@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by drew)',
    ].join('\n');

    expect(darwinMounts(mountOutput)).toEqual(['/System/Volumes/Data', '/Volumes/Backup Drive']);
  });
});

describe('disk usage', () => {
  test('counts blocks the filesystem holds as used, reserved blocks included', () => {
    const stat = { bavail: 50, bfree: 60, blocks: 100, bsize: 4096 };

    expect(diskUsage('/', stat)).toEqual({
      mount: '/',
      totalBytes: 100 * 4096,
      usedBytes: 40 * 4096,
    });
  });
});
