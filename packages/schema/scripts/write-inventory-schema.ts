// Regenerates the committed Inventory JSON Schema from the zod schema.
import { inventoryJsonSchema } from '../src/json-schema.ts';

await Bun.write(new URL('../inventory.v1.schema.json', import.meta.url), inventoryJsonSchema());
