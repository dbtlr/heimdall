import { createFileRoute } from '@tanstack/react-router';

import { database } from '../server/database.ts';
import { healthAnswer } from '../server/health.ts';
import { onlyGet } from '../server/only-get.ts';
import { DASHBOARD_VERSION } from '../version.ts';

// The health check `service status` and a provisioner ask, as the Hub answers its own.
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      ANY: onlyGet,
      GET: () => healthAnswer({ database, version: DASHBOARD_VERSION }),
    },
  },
});
