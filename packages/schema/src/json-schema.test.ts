import { expect, test } from 'bun:test';

import committed from '../inventory.v1.schema.json';
import { inventoryJsonSchema } from './json-schema.ts';

// Fleet validates against the committed file, so it must say what the Hub checks.
test('the committed Inventory JSON Schema matches the schema the Hub parses with', () => {
  expect(committed).toEqual(JSON.parse(inventoryJsonSchema()));
});
