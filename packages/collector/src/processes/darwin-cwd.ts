// Reads a process's working directory on macOS through libproc's
// `proc_pidinfo`, asking for PROC_PIDVNODEPATHINFO. `ps` has no column for it
// and a tool that lists every open file is slow, so the Collector asks the
// kernel for the one path, for the few Harness roots only. The call returns
// a proc_vnodepathinfo: the working directory's vnode_info (152 bytes) and path
// (1024 bytes), then the root directory's. The call is made in the Collector's
// own process and starts nothing. It answers null for a process it may not
// inspect, which belongs to another user, and when libproc cannot be loaded.

const PROC_PIDVNODEPATHINFO = 9;
const VNODE_PATH_INFO_SIZE = 2352;
const CWD_PATH_OFFSET = 152;
const MAX_PATH = 1024;

type ProcPidInfo = (
  pid: number,
  flavor: number,
  arg: bigint,
  buffer: Buffer,
  size: number,
) => number;

let loaded: Promise<ProcPidInfo | undefined> | undefined;

const loadProcPidInfo = async (): Promise<ProcPidInfo | undefined> => {
  try {
    const { dlopen, ptr } = await import('bun:ffi');
    const lib = dlopen('/usr/lib/libproc.dylib', {
      proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
    });
    return (pid, flavor, arg, buffer, size) =>
      lib.symbols.proc_pidinfo(pid, flavor, arg, ptr(buffer), size);
  } catch {
    return undefined;
  }
};

export const darwinCwd = async (pid: number): Promise<string | null> => {
  loaded ??= loadProcPidInfo();
  const procPidInfo = await loaded;
  if (procPidInfo === undefined) {
    return null;
  }
  const buffer = Buffer.alloc(VNODE_PATH_INFO_SIZE);
  const written = procPidInfo(pid, PROC_PIDVNODEPATHINFO, 0n, buffer, VNODE_PATH_INFO_SIZE);
  if (written < CWD_PATH_OFFSET + 1) {
    return null;
  }
  const path = buffer.subarray(CWD_PATH_OFFSET, CWD_PATH_OFFSET + MAX_PATH);
  const end = path.indexOf(0);
  const text = path.toString('utf8', 0, end === -1 ? MAX_PATH : end);
  return text === '' ? null : text;
};
