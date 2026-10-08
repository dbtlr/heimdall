// Regenerates the committed JSON Schemas from the zod schemas.
import {
  installRecordJsonSchema,
  inventoryJsonSchema,
  runRecordJsonSchema,
} from '../src/json-schema.ts';

const write = (file: string, contents: string) =>
  Bun.write(new URL(`../${file}`, import.meta.url), contents);

await Promise.all([
  write('inventory.v1.schema.json', inventoryJsonSchema()),
  write('install-record.v1.schema.json', installRecordJsonSchema()),
  write('run-record.v1.schema.json', runRecordJsonSchema()),
]);
