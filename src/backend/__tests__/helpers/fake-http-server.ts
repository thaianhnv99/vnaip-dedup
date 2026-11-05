import { createServer, type Server } from "node:http";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export interface FakeResponse {
  status: number;
  json?: unknown;
  /** Trì hoãn trước khi trả lời, dùng để test timeout. */
  delayMs?: number;
}

/**
 * Server HTTP giả cho test client (Gemini, Qdrant). Ghi lại mọi request để
 * test kiểm tra đường dẫn, header và body thực sự được gửi đi.
 */
export async function startFakeServer(
  handler: (request: RecordedRequest, index: number) => FakeResponse,
) {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const recorded: RecordedRequest = {
        method: incoming.method ?? "",
        url: incoming.url ?? "",
        headers: incoming.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(recorded);
      const reply = handler(recorded, requests.length - 1);
      setTimeout(() => {
        outgoing.statusCode = reply.status;
        outgoing.setHeader("content-type", "application/json");
        outgoing.end(reply.json === undefined ? "" : JSON.stringify(reply.json));
      }, reply.delayMs ?? 0);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("không bind được fake server");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
