import { configuration } from '@loomcli/plugins/config';
import { toml } from '@loomcli/plugins/config/toml';
import { z } from 'zod';

// The keys of collector.toml. The scalar ones feed options through
// `configInput` links; `sessions` and `updates` stay `unknown`, and `run`
// validates them with `parseSources` and `parseUpdatesConfig`, which refuse a
// bad section at startup.
const collectorFile = z.object({
  hub: z.string().optional(),
  sessions: z.unknown().optional(),
  sleeps: z.boolean().optional(),
  stateDir: z.string().optional(),
  updates: z.unknown().optional(),
});

// `strict` stops the binary with exit code 2, naming the key, on a key the
// schema does not declare or a value it rejects, instead of running on the
// default. A file that is not valid TOML stops it too.
// `plugin` goes in the Application; a Command that reads the file's sections
// declares `uses: [values]` and reads them as `provided.config`.
export const { plugin: configPlugin, values: configValues } = configuration({
  file: '.config/heimdall/collector.{toml,json}',
  formats: [toml],
  schema: collectorFile,
  strict: true,
});
