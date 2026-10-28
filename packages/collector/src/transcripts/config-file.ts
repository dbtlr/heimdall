import { readConfigSection } from '@heimdall/service';

export const readSessionsSection = (options: {
  cwd: string;
  home: string;
  named: string | undefined;
}) => readConfigSection({ ...options, binary: 'collector', section: 'sessions' });
