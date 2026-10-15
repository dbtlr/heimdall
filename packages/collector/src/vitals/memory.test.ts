import { describe, expect, test } from 'bun:test';

import { darwinMemory, darwinMemoryPressure, linuxMemory, readDarwinMemory } from './memory.ts';

test('macOS pressure distinguishes normal, warning, critical, and an unreadable signal', () => {
  expect(darwinMemoryPressure('1\n')).toBe('normal');
  expect(darwinMemoryPressure('2\n')).toBe('warning');
  expect(darwinMemoryPressure('4\n')).toBe('critical');
  expect(darwinMemoryPressure('')).toBeUndefined();
  expect(darwinMemoryPressure('3')).toBeUndefined();
});

describe('Linux memory', () => {
  const meminfo = [
    'MemTotal:       32869552 kB',
    'MemFree:         1459796 kB',
    'MemAvailable:   14184356 kB',
    'Buffers:          402116 kB',
    'Cached:         11874508 kB',
  ].join('\n');

  test('used is total less what the kernel says is available', () => {
    expect(linuxMemory(meminfo)).toEqual({
      totalBytes: 32_869_552 * 1024,
      usedBytes: (32_869_552 - 14_184_356) * 1024,
    });
  });

  test('a meminfo without MemAvailable is an error', () => {
    expect(() => linuxMemory('MemTotal: 1024 kB\n')).toThrow('MemAvailable');
  });
});

describe('macOS memory', () => {
  const vmStat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               12000.',
    'Pages active:                            400000.',
    'Pages inactive:                          390000.',
    'Pages speculative:                         5000.',
    'Pages throttled:                              0.',
    'Pages wired down:                        150000.',
    'Pages purgeable:                           8000.',
    '"Translation faults":                 123456789.',
    'Pages occupied by compressor:             60000.',
  ].join('\n');

  test('used is total less free, inactive, speculative, and purgeable pages', () => {
    const totalBytes = 34_359_738_368;

    expect(darwinMemory(vmStat, totalBytes)).toEqual({
      totalBytes,
      usedBytes: totalBytes - (12_000 + 390_000 + 5000 + 8000) * 16_384,
    });
  });

  test('vm_stat output without a page size is an error', () => {
    expect(() => darwinMemory('Pages free: 1.\n', 1024)).toThrow('page size');
  });

  test('a failed pressure probe preserves memory readings and the probe is read-only', async () => {
    const commands: string[][] = [];
    const memory = await readDarwinMemory({
      read: async (command) => {
        commands.push(command);
        if (command[0] === '/usr/bin/vm_stat') {
          return vmStat;
        }
        throw new Error('Unavailable sysctl');
      },
      totalBytes: 34_359_738_368,
    });
    expect(memory).toEqual(darwinMemory(vmStat, 34_359_738_368));
    expect(commands).toEqual([
      ['/usr/bin/vm_stat'],
      ['/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level'],
    ]);
  });
});
