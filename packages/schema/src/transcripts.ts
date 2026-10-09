import { z } from 'zod';

import { bytes, epochMs } from './values.ts';

// How a Collector uploads transcripts to the Hub, separately from Reports
// (ADR-0013). A Collector opens a generation for each continuous run of a
// file's content, then sends it as gzipped chunks, each at the offset the Hub
// holds:
//
//   POST /api/v1/transcripts/generations          OpenGeneration as JSON
//     201 GenerationOpened · 410 the path was deleted on purpose
//   POST /api/v1/transcripts/generations/<id>/chunks
//     Heimdall-Offset: <uncompressed bytes of the file before this chunk>
//     body: the chunk, gzipped
//     200 ChunkAccepted, stored or already held · 409 ChunkAccepted, the offset
//     is not the one the Hub holds · 410 the generation was deleted on purpose
//
// Both answer 401 without a token, 403 for a token no System holds, and 422
// for a malformed request; a chunk answers 404 for a generation its System did
// not open, 413 above the request cap, and 422 for a body that is not gzip or
// unpacks past the chunk limit.

// The most file content one chunk carries, before compression.
export const MAX_TRANSCRIPT_CHUNK_BYTES = 1024 * 1024;

// The largest chunk body the Hub reads. gzip can grow incompressible content
// slightly, so a full chunk always fits.
export const MAX_TRANSCRIPT_REQUEST_BYTES = 2 * 1024 * 1024;

// The request header that carries a chunk's offset.
export const TRANSCRIPT_OFFSET_HEADER = 'heimdall-offset';

// A source's name: a DNS label, like a System's name.
export const SOURCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

// PATH_MAX on Linux, in bytes of UTF-8.
const MAX_PATH_BYTES = 4096;

// A path within a source's directory, with `/` between segments. It cannot
// leave the directory or name it in two ways, and PostgreSQL can store it. A
// file whose name is not valid UTF-8 has no such path.
const isSourcePath = (path: string) =>
  path.isWellFormed() &&
  new TextEncoder().encode(path).byteLength <= MAX_PATH_BYTES &&
  !path.includes('\0') &&
  path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

// The file a Collector opens a generation for.
export const OpenGenerationSchema = z.object({
  path: z.string().min(1).refine(isSourcePath, {
    message: 'path must be UTF-8 of at most 4096 bytes, relative to the source, without . or ..',
  }),
  source: z.string().regex(SOURCE_NAME),
});

export const GenerationOpenedSchema = z.object({ generation: z.int().positive(), held: bytes });

// How much of the generation's content the Hub holds, from its start.
export const ChunkAcceptedSchema = z.object({ held: bytes });

// One source a Collector's configuration lists, and whether it is capturing:
// `capturing`, `absent`, or `unreadable`. The Harness and the status are any
// short word, so a newer Collector's Harness or status does not reject a
// Report (ADR-0004).
const TranscriptSourceSchema = z.object({
  harness: z.string().min(1).max(64),
  name: z.string().regex(SOURCE_NAME),
  status: z.string().min(1).max(64),
});

// A Report's transcripts section, in every Report from a Collector that
// captures: its whole set of sources and its spool, the content the Hub has
// not yet acknowledged, with when the oldest of it was spooled. No sources
// means capture is off.
export const TranscriptsSectionSchema = z.object({
  sources: z
    .array(TranscriptSourceSchema)
    .max(64)
    .refine((sources) => new Set(sources.map((s) => s.name)).size === sources.length, {
      message: 'source names must be unique',
    }),
  spool: z.object({ bytes, oldestAt: epochMs.nullable() }),
});

export type OpenGeneration = z.infer<typeof OpenGenerationSchema>;
export type GenerationOpened = z.infer<typeof GenerationOpenedSchema>;
export type ChunkAccepted = z.infer<typeof ChunkAcceptedSchema>;
export type TranscriptsSection = z.infer<typeof TranscriptsSectionSchema>;
