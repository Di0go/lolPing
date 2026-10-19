import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest { method: string; url: string; headers: IncomingHttpHeaders; body: string }

/** What the fake answers with: a JSON body with a status, or SSE text written chunk by chunk. */
export type Reply = { status: number; json: unknown } | { sse: string[]; hold?: boolean };

/**
 * Just enough of a model provider for tests: it records every request and answers each with the current reply.
 * SSE chunks are written one per event-loop turn so they reach the client split; `hold` keeps the stream open.
 */
export async function startFakeProvider(): Promise<{
  url: string;
  requests: RecordedRequest[];
  reply(r: Reply): void;
  /** Streams the client dropped before the fake finished them. */
  dropped(): number;
  close(): Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  let current: Reply = { status: 500, json: { error: { message: 'no reply set' } } };
  let dropped = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const r = current;
      if ('json' in r) {
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.on('close', () => { if (!res.writableEnded) dropped++; });
      void (async () => {
        for (const chunk of r.sse) {
          if (res.destroyed) return;
          res.write(chunk);
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (!r.hold) res.end();
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply: (r) => { current = r; },
    dropped: () => dropped,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
