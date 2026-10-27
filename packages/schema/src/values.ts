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

// Free text for a person to read: no control characters, so it cannot rewrite a
// terminal or break a line, and well-formed Unicode, so PostgreSQL can store it
// in a Report.
export const text = (maxLength = 256) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .regex(/^\P{Cc}+$/u, { message: 'must not contain control characters' })
    .refine((value) => value.isWellFormed(), { message: 'must be well-formed Unicode' });
