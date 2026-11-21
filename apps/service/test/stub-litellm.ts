import { createServer } from 'node:http';

export interface StubHandle {
  url: string;
  state: {
    embeddings: number[];
    chatLog: any[];
    responses: string[];
  };
}

/** Create a stub server that returns fixed-dim embeddings and queued chat responses. */
export async function startStub(dim: number): Promise<StubHandle> {
  const port = Math.floor(Math.random() * 10000) + 10000; // random port in 10000-19999
  const handle: StubHandle = {
    url: `http://localhost:${port}`,
    state: {
      embeddings: new Array<number>(dim).fill(0.5),
      chatLog: [],
      responses: [],
    },
  };
  const server = createServer(async (req, res) => {
    const { method, url: reqUrl = '', headers } = req;
    const body = await new Promise<string>((resolve) => {
      let buf = '';
      req.on('data', (chunk) => (buf += chunk));
      req.on('end', () => resolve(buf));
    });

    try {
      const parsed = method === 'POST' ? JSON.parse(body) : undefined;

      if (reqUrl.endsWith('/embeddings')) {
        const vector = new Array<number>(dim).fill(0.5);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: vector }] }));
      } else if (reqUrl.endsWith('/chat/completions')) {
        if (parsed?.messages && parsed.messages.length > 0) {
          if (handle.state.responses.length > 0) {
            const queued = handle.state.responses.shift()!;
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
        path: reqUrl,
        method,
        body,
      });
    } catch (err) {
      console.error('Stub server error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  const listener = server.listen(port, 'localhost', () => {
    const address = server.address();
    if (typeof address === 'string') {
      // This shouldn't happen
      console.error('Server listening on unknown address');
    } else if (address) {
      const host = address.address;
      const port = address.port;
      console.log(`Stub server listening at http://${host}:${port}`);
    }
  });

  // Wait a bit for the port to be assigned (especially on some systems)
  await new Promise((resolve) => setTimeout(resolve, 10));

  return handle;
}

/** Queue a chat completion response. */
export function queueChat(handle: StubHandle, content: string): void {
  handle.state.responses.push(content);
}

/** Get the number of chat completions recorded. */
export function completionCount(handle: StubHandle): number {
  return handle.state.chatLog.filter((c) => c.path.endsWith('/chat/completions')).length;
}