const NEWLINE = '\n'.charCodeAt(0);

// Cuts the start of `content` into chunks of at most `limit` bytes, each ending
// on a line boundary unless one line is longer than `limit`, which is split
// there (ADR-0013). A partial last line is left for a later read unless the
// file is `final`, unchanged since the previous scan, so a file that ends
// without a newline, or is not JSONL at all, still uploads whole. `consumed`
// counts the bytes the chunks hold, from the start of `content`.
export const cutChunks = (
  content: Uint8Array,
  { final, limit }: { final: boolean; limit: number },
): { chunks: Uint8Array[]; consumed: number } => {
  const chunks: Uint8Array[] = [];
  let start = 0;
  while (start < content.length) {
    const window = content.subarray(start, start + limit);
    const fits = start + limit >= content.length;
    let end: number;
    if (fits && final) {
      end = content.length;
    } else {
      const lastNewline = window.lastIndexOf(NEWLINE);
      if (lastNewline !== -1) {
        end = start + lastNewline + 1;
      } else if (window.length === limit) {
        end = start + limit;
      } else {
        break;
      }
    }
    chunks.push(content.subarray(start, end));
    start = end;
  }
  return { chunks, consumed: start };
};
