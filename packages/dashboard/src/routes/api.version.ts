import { createFileRoute } from '@tanstack/react-router';

import { onlyGet } from '../server/only-get.ts';
import { versionAnswer } from '../server/version-answer.ts';
import { DASHBOARD_BUILD, DASHBOARD_VERSION } from '../version.ts';

// The build a page compares with its own to see a newer dashboard is ready.
export const Route = createFileRoute('/api/version')({
  server: {
    handlers: {
      ANY: onlyGet,
      GET: () => versionAnswer({ build: DASHBOARD_BUILD, version: DASHBOARD_VERSION }),
    },
  },
});
