import { createServer } from 'node:http';

export interface StubHandle {
  url: string;
  state: {
    embeddings: number[];
    chatLog: any[];
    responses: string[];
  };
  close(): Promise<void>;
}

/** Create a stub server that returns fixed-dim embeddings and queued chat responses. */
export async function startStub(dim: number): Promise<StubHandle> {
  const port = Math.floor(Math.random() * 10000) + 10000; // random port in 10000-19999
  const state = {
    embeddings: new Array<number>(dim).fill(0.5),
    chatLog: [] as any[],
    responses: [] as string[],
  };
  const server = createServer(async (req, res) => {
    const { method, url, headers } = req;
    const body = await new Promise<string>((resolve) => {
      let buf = '';
      req.on('data', (chunk) => (buf += chunk));
      req.on('end', () => resolve(buf));
    });
    const path = url ?? '';

    try {
      const parsed = method === 'POST' ? JSON.parse(body) : undefined;

      if (url.endsWith('/embeddings')) {
        const vector = new Array<number>(dim).fill(0.5);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: vector }] }));
      } else if (url.endsWith('/chat/completions')) {
        if (parsed?.messages && parsed.messages.length > 0) {
          if (state.responses.length > 0) {
            const queued = state.responses.shift()!;
            const respBody = JSON.parse(queued);
            const content = respBody.choices?.[0]?.message?.content ?? '';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content } }] }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No queued response' }));
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request' }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }

      // Log request
      handle.state.chatLog.push({
        path: url,
        method,
        body,
      });
    } catch (err) {
      console.error('Stub server error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  server.listen(port, 'localhost');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });

  return {
    url: `http://localhost:${(server.address() as { port: number }).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Queue a chat completion response. */
export function queueChat(handle: StubHandle, content: string): void {
  handle.state.responses.push(content);
}

/** Get the number of chat completions recorded. */
export function completionCount(handle: StubHandle): number {
  return handle.state.chatLog.filter((c) => c.path.endsWith('/chat/completions')).length;
}