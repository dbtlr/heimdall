// Asks the macOS kernel, through libproc's `proc_pidinfo` and `proc_pidpath`,
// for what `ps` cannot give exactly: a process's working directory, its
// executable's path, and the start time the kernel recorded for it. The calls are made in the Collector's own
// process and start nothing. Exact starts distinguish every sampled process;
// working directories and executable paths are read only for candidates. Each
// answers null for a process it may not inspect, which belongs to another
// user, and when libproc cannot be loaded.

// PROC_PIDVNODEPATHINFO returns a proc_vnodepathinfo: the working directory's
// vnode_info (152 bytes) and path (1024 bytes), then the root directory's.
const PROC_PIDVNODEPATHINFO = 9;
const VNODE_PATH_INFO_SIZE = 2352;
const CWD_PATH_OFFSET = 152;
const MAX_PATH = 1024;

// `proc_pidpath` writes the executable's path, NUL-terminated, into a buffer
// of PROC_PIDPATHINFO_MAXSIZE, four times MAXPATHLEN, and returns its length,
// or 0 or less on failure. It is the image the kernel ran, not argv[0]. It is
// not asked through `proc_pidinfo`, whose PROC_PIDPATHINFO flavor returns 0
// even when it succeeds.
const PROC_PIDPATHINFO_MAXSIZE = 4096;

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

export type ProcPidPath = (pid: number, buffer: Buffer, size: number) => number;

type LibProc = { procPidInfo: ProcPidInfo; procPidPath: ProcPidPath };

let loaded: Promise<LibProc | undefined> | undefined;

// libproc's calls are exported by libSystem, which every process loads; there
// is no separate libproc library file to open on current macOS.
const loadLibProc = async (): Promise<LibProc | undefined> => {
  try {
    const { dlopen, ptr } = await import('bun:ffi');
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
      proc_pidpath: { args: ['i32', 'ptr', 'u32'], returns: 'i32' },
    });
    return {
      procPidInfo: (pid, flavor, arg, buffer, size) =>
        lib.symbols.proc_pidinfo(pid, flavor, arg, ptr(buffer), size),
      procPidPath: (pid, buffer, size) => lib.symbols.proc_pidpath(pid, ptr(buffer), size),
    };
  } catch {
    return undefined;
  }
};

const libProc = () => {
  loaded ??= loadLibProc();
  return loaded;
};

// The buffer `proc_pidinfo` filled for `flavor`, or undefined when it filled
// fewer than `needed` bytes.
const pidInfo = async (pid: number, flavor: number, size: number, needed: number) => {
  const procPidInfo = (await libProc())?.procPidInfo;
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

// The path `procPidPath` gives for a process, or null when it fails.
export const pathWith = (procPidPath: ProcPidPath, pid: number): string | null => {
  const buffer = Buffer.alloc(PROC_PIDPATHINFO_MAXSIZE);
  const length = procPidPath(pid, buffer, PROC_PIDPATHINFO_MAXSIZE);
  if (length <= 0) {
    return null;
  }
  return buffer.toString('utf8', 0, Math.min(length, PROC_PIDPATHINFO_MAXSIZE));
};

// The path of the executable a process runs.
export const darwinPath = async (pid: number): Promise<string | null> => {
  const procPidPath = (await libProc())?.procPidPath;
  return procPidPath === undefined ? null : pathWith(procPidPath, pid);
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
