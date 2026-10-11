// Asks the macOS kernel, through libproc's `proc_pidinfo`, for what `ps`
// cannot give exactly: a process's working directory, its executable's path,
// and the start time the kernel recorded for it. The calls are made in the Collector's own
// process and start nothing, and only for the few Harness processes. Each
// answers null for a process it may not inspect, which belongs to another
// user, and when libproc cannot be loaded.

// PROC_PIDVNODEPATHINFO returns a proc_vnodepathinfo: the working directory's
// vnode_info (152 bytes) and path (1024 bytes), then the root directory's.
const PROC_PIDVNODEPATHINFO = 9;
const VNODE_PATH_INFO_SIZE = 2352;
const CWD_PATH_OFFSET = 152;
const MAX_PATH = 1024;

// PROC_PIDPATHINFO returns the executable's path, NUL-terminated, in a buffer
// of four times MAXPATHLEN. It is the image the kernel ran, not argv[0].
const PROC_PIDPATHINFO = 11;
const PATH_INFO_SIZE = 4096;

// PROC_PIDTBSDINFO returns a proc_bsdinfo, 136 bytes, which ends with the
// start's seconds and microseconds as two 64-bit fields. Only those are read.
const PROC_PIDTBSDINFO = 3;
const BSD_INFO_SIZE = 136;
const START_SECONDS_OFFSET = 120;
const START_MICROS_OFFSET = 128;
const MICROS_PER_SECOND = 1_000_000n;

type ProcPidInfo = (
  pid: number,
  flavor: number,
  arg: bigint,
  buffer: Buffer,
  size: number,
) => number;

let loaded: Promise<ProcPidInfo | undefined> | undefined;

// `proc_pidinfo` is exported by libSystem, which every process loads; there is
// no separate libproc library file to open on current macOS.
const loadProcPidInfo = async (): Promise<ProcPidInfo | undefined> => {
  try {
    const { dlopen, ptr } = await import('bun:ffi');
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
    });
    return (pid, flavor, arg, buffer, size) =>
      lib.symbols.proc_pidinfo(pid, flavor, arg, ptr(buffer), size);
  } catch {
    return undefined;
  }
};

// The buffer `proc_pidinfo` filled for `flavor`, or undefined when it filled
// fewer than `needed` bytes.
const pidInfo = async (pid: number, flavor: number, size: number, needed: number) => {
  loaded ??= loadProcPidInfo();
  const procPidInfo = await loaded;
  if (procPidInfo === undefined) {
    return undefined;
  }
  const buffer = Buffer.alloc(size);
  return procPidInfo(pid, flavor, 0n, buffer, size) < needed ? undefined : buffer;
};

export const darwinCwd = async (pid: number): Promise<string | null> => {
  const buffer = await pidInfo(
    pid,
    PROC_PIDVNODEPATHINFO,
    VNODE_PATH_INFO_SIZE,
    CWD_PATH_OFFSET + 1,
  );
  if (buffer === undefined) {
    return null;
  }
  const path = buffer.subarray(CWD_PATH_OFFSET, CWD_PATH_OFFSET + MAX_PATH);
  const end = path.indexOf(0);
  const text = path.toString('utf8', 0, end === -1 ? MAX_PATH : end);
  return text === '' ? null : text;
};

// The path of the executable a process runs.
export const darwinPath = async (pid: number): Promise<string | null> => {
  const buffer = await pidInfo(pid, PROC_PIDPATHINFO, PATH_INFO_SIZE, 1);
  if (buffer === undefined) {
    return null;
  }
  const end = buffer.indexOf(0);
  const text = buffer.toString('utf8', 0, end === -1 ? PATH_INFO_SIZE : end);
  return text === '' ? null : text;
};

// The start the kernel recorded for a process, in microseconds since the epoch.
export const darwinKernelStart = async (pid: number): Promise<number | null> => {
  const buffer = await pidInfo(pid, PROC_PIDTBSDINFO, BSD_INFO_SIZE, BSD_INFO_SIZE);
  if (buffer === undefined) {
    return null;
  }
  const micros =
    buffer.readBigUInt64LE(START_SECONDS_OFFSET) * MICROS_PER_SECOND +
    buffer.readBigUInt64LE(START_MICROS_OFFSET);
  return Number(micros);
};
