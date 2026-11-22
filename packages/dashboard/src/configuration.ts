import { configuration } from '@loomcli/plugins/config';
import { toml } from '@loomcli/plugins/config/toml';
import { z } from 'zod';

// The keys of dashboard.toml, which feed options through `configInput` links. `strict` stops the binary
// with exit code 2, naming the key, on a key it does not declare or a value it
// rejects, instead of running on the default.
const dashboardFile = z.object({
  host: z.string().optional(),
  port: z.union([z.string(), z.number()]).optional(),
});

export const { plugin: configPlugin } = configuration({
  file: '.config/heimdall/dashboard.{toml,json}',
  formats: [toml],
  schema: dashboardFile,
  strict: true,
});
