import serverless from 'serverless-http';
import { createApp } from './app.mjs';

// Keep the tested Express API behind a standard Request/Response entry point.
export function createFetchHandler(options) {
  const handle = serverless(createApp({ ...options, serveStatic: false }), { binary: ['audio/*'] });
  return async (request, clientIp) => {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers);
    // Trust the hosting platform's client IP, never a caller-supplied proxy header.
    headers['x-forwarded-for'] = clientIp;
    const body = Buffer.from(await request.arrayBuffer());
    if (body.length > 8192) return Response.json({ error: 'Request too large.' }, { status: 413 });
    const result = await handle({
      version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1),
      headers, body: body.toString('base64'), isBase64Encoded: true,
      requestContext: { http: { method: request.method, sourceIp: clientIp, path: url.pathname, protocol: 'HTTP/1.1' } },
    }, {});
    const responseHeaders = new Headers(result.headers);
    for (const cookie of result.cookies || []) responseHeaders.append('Set-Cookie', cookie);
    responseHeaders.delete('content-length');
    return new Response(request.method === 'HEAD' || [204, 304].includes(result.statusCode) ? null : Buffer.from(result.body || '', result.isBase64Encoded ? 'base64' : 'utf8'), {
      status: result.statusCode, headers: responseHeaders,
    });
  };
}
