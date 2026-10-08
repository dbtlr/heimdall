import { z } from 'zod';

import { InventorySchema } from './inventory.ts';

// The Inventory as the JSON Schema file Fleet validates against before it
// publishes, formatted as committed.
export const inventoryJsonSchema = () =>
  `${JSON.stringify(z.toJSONSchema(InventorySchema), undefined, 2)}\n`;
