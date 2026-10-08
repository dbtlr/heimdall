import { z } from 'zod';

import { InstallRecordSchema } from './install-record.ts';
import { InventorySchema } from './inventory.ts';
import { RunRecordSchema } from './run-record.ts';

// A schema as the JSON Schema file Fleet validates against, formatted as committed.
const jsonSchemaFile = (schema: z.ZodType) =>
  `${JSON.stringify(z.toJSONSchema(schema), undefined, 2)}\n`;

// The Inventory Fleet validates before it publishes.
export const inventoryJsonSchema = () => jsonSchemaFile(InventorySchema);
// The install and run records Fleet validates before it writes them.
export const installRecordJsonSchema = () => jsonSchemaFile(InstallRecordSchema);
export const runRecordJsonSchema = () => jsonSchemaFile(RunRecordSchema);
