import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_CONTROL_BODY_BYTES = 10 * 1024 * 1024;

/** Reads a bounded JSON request body with strict UTF-8 decoding. */
export async function readControlRequestBody(
  req: IncomingMessage,
  maxBytes = MAX_CONTROL_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Stopping early must not destroy the request: the response writer
  // discards the unread rest so the client receives the typed 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      chunks.length = 0;
      throw Object.assign(new Error("request body too large"), { status: 413 });
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  // QA-056: decode the complete byte body STRICTLY. `Buffer.toString("utf8")`
  // is non-fatal — it silently replaces malformed bytes with U+FFFD, so an
  // invalid octet (FF, a lone continuation byte, overlong/ truncated sequence)
  // would slip through as a valid JS string and could pass Zod, the secret
  // fence, idempotency hashing and a durable mutation storing a value that
  // differs from the wire bytes. TextDecoder({fatal:true}) throws on any
  // malformed byte; concatenating first keeps valid multibyte chars split
  // across HTTP chunks intact.
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw Object.assign(new Error("request body must be valid UTF-8"), {
      status: 400,
      code: "invalid_encoding",
    });
  }
  const raw = decoded.trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

/** An early answer to a request whose body is still arriving discards the rest
 * and keeps the connection, so the client can read the answer. */
export function discardUnreadBody(res: ServerResponse): void {
  if (res.req && !res.req.complete) res.req.resume();
}
