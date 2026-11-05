import { configuration } from '@loomcli/plugins/config';
import { z } from 'zod';

// The keys of collector.toml. The scalar ones feed options through
// `configInput` links; `sessions` and `updates` stay `unknown` so Loom never
// drops anything inside them, and `run` validates them with `parseSources` and
// `parseUpdatesConfig`, which refuse a bad section at startup.
const collectorFile = z.object({
  hub: z.string().optional(),
  sessions: z.unknown().optional(),
  sleeps: z.boolean().optional(),
  stateDir: z.string().optional(),
  updates: z.unknown().optional(),
});

// `plugin` goes in the Application; a Command that reads the file's sections
// declares `uses: [values]` and reads them as `provided.config`.
export const { plugin: configPlugin, values: configValues } = configuration({
  file: '.config/heimdall/collector.{toml,json}',
  schema: collectorFile,
});
