import { createFileRoute } from '@tanstack/react-router';

import { database } from '../server/database.ts';
import { healthAnswer } from '../server/health.ts';
import { DASHBOARD_VERSION } from '../version.ts';

// The health check `service status` and a provisioner ask, as the Hub answers its own.
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => healthAnswer({ database, version: DASHBOARD_VERSION }),
    },
  },
});
