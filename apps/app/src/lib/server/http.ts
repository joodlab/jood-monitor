export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY = 4 * 1024 * 1024;

export async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  maximum = MAX_BODY
) {
  if (!stream) {
    return new Uint8Array();
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      size += result.value.byteLength;
      if (size > maximum) {
        throw new HttpError(413, "batch byte quota");
      }
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBody(request: Request) {
  const encoded = await readBounded(request.body);
  const encoding = request.headers.get("Content-Encoding");
  if (encoding && encoding !== "gzip" && encoding !== "identity") {
    throw new HttpError(415, "unsupported content encoding");
  }
  if (encoding !== "gzip") {
    return encoded;
  }
  try {
    const stream = new Blob([encoded])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return await readBounded(stream);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "invalid compression");
  }
}

export async function readJson(request: Request) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readBody(request))
    ) as unknown;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "invalid JSON");
  }
}

export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
