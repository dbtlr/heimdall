import { createFileRoute } from '@tanstack/react-router';

import { database } from '../server/database.ts';
import { onlyGet } from '../server/only-get.ts';
import { recordsAnswer } from '../server/records.ts';

// The records read a provisioner compares its declarations with. Any other
// method than GET answers 405.
export const Route = createFileRoute('/api/v1/records')({
  server: {
    handlers: {
      ANY: onlyGet,
      GET: ({ request }) =>
        recordsAnswer({
          database,
          // To stderr, which the Service appends to its log beside the 503 line.
          onError: (error) => {
            console.error('The records read failed:', error);
          },
          url: new URL(request.url),
        }),
    },
  },
});
