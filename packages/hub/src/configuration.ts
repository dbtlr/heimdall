import { configuration } from '@loomcli/plugins/config';
import { z } from 'zod';

// The keys of hub.toml. The scalar ones feed options through `configInput`
// links; `conditions` and `delivery` stay `unknown` so Loom never drops
// anything inside them, and `serve` validates them with `parseConditionLimits`
// and `parseDeliveryChannel`, which refuse a bad section at startup.
const hubFile = z.object({
  conditions: z.unknown().optional(),
  database: z
    .object({ insight_reader: z.string().optional(), url: z.string().optional() })
    .optional(),
  delivery: z.unknown().optional(),
  host: z.string().optional(),
  port: z.union([z.string(), z.number()]).optional(),
  prices: z.object({ overrides: z.string().optional() }).optional(),
});

// `plugin` goes in the Application; a Command that reads the file's sections
// declares `uses: [values]` and reads them as `provided.config`.
export const { plugin: configPlugin, values: configValues } = configuration({
  file: '.config/heimdall/hub.{toml,json}',
  schema: hubFile,
});
