import { createFileRoute } from '@tanstack/react-router';

import { database } from '../server/database.ts';
import { onlyGet } from '../server/only-get.ts';
import { serviceStopsAnswer } from '../server/service-stops.ts';

// Service stops are observations, read apart from provisioner records.
export const Route = createFileRoute('/api/v1/service-stops')({
  server: {
    handlers: {
      ANY: onlyGet,
      GET: ({ request }) =>
        serviceStopsAnswer({
          database,
          // To stderr, which the Service appends to its log beside the 503 line.
          onError: (error) => {
            console.error('The Service stops read failed:', error);
          },
          url: new URL(request.url),
        }),
    },
  },
});
