import { configuration } from '@loomcli/plugins/config';
import { toml } from '@loomcli/plugins/config/toml';
import { z } from 'zod';

// The keys of hub.toml. The scalar ones feed options through `configInput`
// links; `conditions` and `delivery` stay `unknown`, and `serve` validates them
// with `parseConditionLimits` and `parseDeliveryChannel`, which refuse a bad
// section at startup.
const hubFile = z.object({
  conditions: z.unknown().optional(),
  database: z
    .object({ insight_reader: z.string().optional(), url: z.string().optional() })
    .optional(),
  delivery: z.unknown().optional(),
  host: z.string().optional(),
  port: z.union([z.string(), z.number()]).optional(),
  prices: z.object({ overrides: z.string().optional(), source: z.string().optional() }).optional(),
});

// `strict` stops the binary with exit code 2, naming the key, on a key the
// schema does not declare or a value it rejects, instead of running on the
// default. A file that is not valid TOML stops it too.
// `plugin` goes in the Application; a Command that reads the file's sections
// declares `uses: [values]` and reads them as `provided.config`.
export const { plugin: configPlugin, values: configValues } = configuration({
  file: '.config/heimdall/hub.{toml,json}',
  formats: [toml],
  schema: hubFile,
  strict: true,
});
