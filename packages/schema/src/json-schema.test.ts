import { expect, test } from 'bun:test';

import installRecord from '../install-record.v1.schema.json';
import inventory from '../inventory.v1.schema.json';
import runRecord from '../run-record.v1.schema.json';
import {
  installRecordJsonSchema,
  inventoryJsonSchema,
  runRecordJsonSchema,
} from './json-schema.ts';

// Fleet validates against the committed files, so each must say what Heimdall checks.
test.each([
  ['Inventory', inventory, inventoryJsonSchema],
  ['install record', installRecord, installRecordJsonSchema],
  ['run record', runRecord, runRecordJsonSchema],
])(
  'the committed %s JSON Schema matches the schema Heimdall parses with',
  (_, committed, generate) => {
    expect(committed).toEqual(JSON.parse(generate()));
  },
);
