import { configuration } from '@loomcli/plugins/config';
import { toml } from '@loomcli/plugins/config/toml';
import { z } from 'zod';

// The keys of dashboard.toml, which feed options through `configInput` links.
const dashboardFile = z.object({
  host: z.string().optional(),
  port: z.union([z.string(), z.number()]).optional(),
});

export const { plugin: configPlugin } = configuration({
  file: '.config/heimdall/dashboard.{toml,json}',
  formats: [toml],
  schema: dashboardFile,
});
