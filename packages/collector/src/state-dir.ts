import { join } from 'node:path';

import { homeOf } from '@heimdall/service';

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

// The state directory a command uses: the one its option, variable, or
// configuration names, else the default under the account's home.
export const resolveStateDir = ({
  env,
  option,
  platform = process.platform,
}: {
  env: Readonly<Record<string, string | undefined>>;
  option: string | undefined;
  platform?: NodeJS.Platform;
}): string => option ?? defaultStateDir({ env, home: homeOf(env), platform });
