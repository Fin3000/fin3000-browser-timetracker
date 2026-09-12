import { createServer } from 'node:http';

export async function faultProxy(target, fault) {
  const state = { armed: false, consumed: false, requests: 0, committed: 0, receipts: 0 };
  const server = createServer(async (req, res) => {
    try {
      const mutation = req.method === 'POST' && req.url === '/api/v1/timetracker/browser/start/';
      if (req.url?.startsWith('/api/v1/timetracker/browser/receipts/')) state.receipts++;
      if (mutation) state.requests++;
      const lose = mutation && state.armed && !state.consumed;
      if (lose && fault === 'request-loss') {
        state.consumed = true;
        req.resume();
        res.writeHead(502);
        res.end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      delete headers['content-length'];
      const response = await fetch(target + req.url, {
        method: req.method,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (mutation && response.status === 201) state.committed++;
      // A synthetic gateway failure suppresses the real result. A TCP reset
      // alone lets Firefox transparently retry POST before the extension sees it.
      if (lose && fault === 'response-loss') {
        state.consumed = true;
        res.writeHead(502);
        res.end();
        return;
      }
      res.writeHead(
        response.status,
        Object.fromEntries(
          ['content-type', 'cache-control', 'retry-after']
            .filter((k) => response.headers.has(k))
            .map((k) => [k, response.headers.get(k)]),
        ),
      );
      res.end(body);
    } catch {
      res.writeHead(502);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
