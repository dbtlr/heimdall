import { join } from 'node:path';

// Where the Collector keeps its queue when no state directory is configured:
// the per-user state location each platform's conventions name.
export const defaultStateDir = ({
  env,
  home,
  platform,
}: {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  platform: NodeJS.Platform;
}): string => {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'heimdall');
  }
  const xdgStateHome = env.XDG_STATE_HOME;
  return join(
    xdgStateHome === undefined || xdgStateHome === ''
      ? join(home, '.local', 'state')
      : xdgStateHome,
    'heimdall',
  );
};
