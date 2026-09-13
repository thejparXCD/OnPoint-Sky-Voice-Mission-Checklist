import { describe, expect, it } from 'vitest';
import { createFetchHandler } from '../server/fetch-adapter.mjs';

const origin = 'https://checklists.example.com';
const env = { NODE_ENV: 'production', APP_ORIGIN: origin, APP_ACCESS_CODE: 'test-access-code', SESSION_SECRET: 'test-session-secret-which-is-long-enough', ELEVENLABS_API_KEY: 'test-key' };
const jsonHeaders = { 'Content-Type': 'application/json', 'X-OnPoint-Client': '1', Origin: origin };

describe('Hosted Request/Response adapter', () => {
  it('preserves signed sessions and exact binary audio bytes', async () => {
    const bytes = new Uint8Array(Array.from({ length: 128 }, (_, i) => i * 2));
    const handle = createFetchHandler({ env, fetchImpl: async () => new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg' } }) });
    const call = (path, options) => handle(new Request(origin + path, options), '198.51.100.10');
    const config = await (await call('/api/config')).json();
    expect(config.authenticated).toBe(false);
    const login = await call('/api/session', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ code: env.APP_ACCESS_CODE }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure');
    const session = cookie.split(';')[0];
    expect((await (await call('/api/config', { headers: { Cookie: session } })).json()).authenticated).toBe(true);
    const catalog = await (await call('/api/catalog')).json();
    const audio = await call(`/api/audio/voice-test?revision=${catalog.revision}&voice=${config.audioVersion}`, { headers: { Cookie: session } });
    expect(audio.status).toBe(200); expect(audio.headers.get('content-type')).toContain('audio/mpeg');
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(bytes);
    expect(audio.headers.get('cache-control')).toBe('no-store');
  });

  it('uses the platform IP for guess limits despite spoofed forwarding headers', async () => {
    const handle = createFetchHandler({ env });
    let response;
    for (let i = 0; i < 11; i++) {
      response = await handle(new Request(origin + '/api/session', { method: 'POST', headers: { ...jsonHeaders, 'X-Forwarded-For': `203.0.113.${i}` }, body: '{"code":"wrong"}' }), '198.51.100.20');
    }
    expect(response.status).toBe(429);
  });

  it('rejects foreign origins and oversized requests before forwarding them', async () => {
    const handle = createFetchHandler({ env });
    const foreign = await handle(new Request(origin + '/api/session', { method: 'POST', headers: { ...jsonHeaders, Origin: 'https://other.example.com' }, body: '{}' }), '198.51.100.30');
    expect(foreign.status).toBe(403);
    const large = await handle(new Request(origin + '/api/session', { method: 'POST', headers: jsonHeaders, body: 'x'.repeat(9000) }), '198.51.100.30');
    expect(large.status).toBe(413);
  });
});
