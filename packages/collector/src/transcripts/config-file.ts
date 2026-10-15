import { readConfigSection } from '@heimdall/service';

export { configHome } from '@heimdall/service';

export const readSessionsSection = (options: {
  cwd: string;
  home: string | undefined;
  named: string | undefined;
}) => readConfigSection({ ...options, binary: 'collector', section: 'sessions' });
