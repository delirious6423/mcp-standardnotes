/** Pipe reads can split any UTF-8 sequence. Decode once, strictly, after bounding total bytes. */
export async function readGuiFrame(chunks: AsyncIterable<Buffer | string>): Promise<unknown> {
  const pieces: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of chunks) {
    const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += piece.length;
    if (bytes > 65536) throw new Error("Request too large");
    pieces.push(piece);
  }
  const text = new TextDecoder("utf-8", {fatal:true}).decode(Buffer.concat(pieces));
  return JSON.parse(text) as unknown;
}
