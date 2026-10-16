import { z } from 'zod';

// PostgreSQL text cannot carry NUL or lone surrogates. Identity schemas use
// the same normalization as storage so their keys match their observations.
export const storableText = (text: string) => text.toWellFormed().replaceAll('\0', '�');

// A count of bytes.
export const bytes = z.int().nonnegative();

// The last moment a JavaScript Date can hold; a later time is a Collector bug.
const LAST_DATE_MS = 8_640_000_000_000_000;

// A moment as epoch milliseconds.
export const epochMs = z.int().nonnegative().max(LAST_DATE_MS);
