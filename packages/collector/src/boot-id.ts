import { readCommand } from './subprocess.ts';

// The kernel's id for the boot the System is running, which changes at every
// boot. An empty id is an error, since every boot would share it.
const bootIdOf = (text: string) => {
  const id = text.trim();
  if (id === '') {
    throw new Error('The kernel returned no boot identity.');
  }
  return id;
};

// Linux's boot id, from /proc, or from `root` where a test mounts its own.
export const linuxBootId = async (
  read: (path: string) => Promise<string> = (path) => Bun.file(path).text(),
  root = '/proc',
): Promise<string> => bootIdOf(await read(`${root}/sys/kernel/random/boot_id`));

// macOS's boot session UUID, from sysctl.
export const darwinBootId = async (
  run: (cmd: readonly string[]) => Promise<string> = readCommand,
): Promise<string> => bootIdOf(await run(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid']));

// The boot id of the System the Collector runs on.
export const systemBootId = (): Promise<string> =>
  process.platform === 'darwin' ? darwinBootId() : linuxBootId();
