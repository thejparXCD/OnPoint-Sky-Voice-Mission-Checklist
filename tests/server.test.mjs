import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.mjs';
const env={NODE_ENV:'production',APP_ACCESS_CODE:'test-only-passphrase',SESSION_SECRET:'test-only-session-secret',APP_ORIGIN:'https://checklist.example',ELEVENLABS_API_KEY:'test-only-eleven-key'};
const login=agent=>agent.post('/api/session').set('X-OnPoint-Client','1').set('Origin',env.APP_ORIGIN).send({code:env.APP_ACCESS_CODE});
async function auth(app){const response=await login(request(app));return response.headers['set-cookie'][0].split(';')[0];}
describe('Server security and voice routing',()=>{
  it('fails closed in production without private authentication',()=>expect(()=>createApp({env:{NODE_ENV:'production'}})).toThrow());
  it('exposes only connection status, never secrets',async()=>{
    const response=await request(createApp({env})).get('/api/config');
    expect(response.status).toBe(200);expect(response.body.voiceId).toBe('TWutjvRaJqAX89preB4e');
    expect(response.text).not.toContain(env.ELEVENLABS_API_KEY);expect(response.text).not.toContain(env.SESSION_SECRET);
  });
  it('rejects unauthenticated access, cross-origin requests, and arbitrary narration',async()=>{
    const fetchImpl=vi.fn();const app=createApp({env,fetchImpl});
    expect((await request(app).post('/api/scribe-token').set('X-OnPoint-Client','1')).status).toBe(401);
    expect((await request(app).post('/api/session').set('Origin','https://attacker.example').set('X-OnPoint-Client','1').send({code:env.APP_ACCESS_CODE})).status).toBe(403);
    expect((await request(app).post('/api/session').send({code:env.APP_ACCESS_CODE})).status).toBe(403);
    const cookie=await auth(app);
    expect((await request(app).get('/api/audio/arbitrary-text').set('Cookie',cookie)).status).toBe(404);expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects altered session cookies and rate limits guesses',async()=>{
    const app=createApp({env});const cookie=await auth(app);
    expect((await request(app).post('/api/scribe-token').set('X-OnPoint-Client','1').set('Cookie',cookie+'changed')).status).toBe(401);
    for(let i=0;i<9;i++)await request(app).post('/api/session').set('X-OnPoint-Client','1').send({code:'wrong'});
    expect((await login(request(app))).status).toBe(429);
  });
  it('mints only a scoped single-use Scribe token',async()=>{
    const fetchImpl=vi.fn(async()=>Response.json({token:'single-use-token'}));const app=createApp({env,fetchImpl});const cookie=await auth(app);
    const response=await request(app).post('/api/scribe-token').set('X-OnPoint-Client','1').set('Cookie',cookie);
    expect(response.body).toEqual({token:'single-use-token'});
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe');
    expect(fetchImpl.mock.calls[0][1].headers['xi-api-key']).toBe(env.ELEVENLABS_API_KEY);
  });
  it('uses the chosen voice, validates the revision, and caches identical speech',async()=>{
    const fetchImpl=vi.fn(async()=>new Response(new Uint8Array(128),{headers:{'Content-Type':'audio/mpeg'}}));const app=createApp({env,fetchImpl});const cookie=await auth(app);
    const {body:config}=await request(app).get('/api/config');const {body:catalog}=await request(app).get('/api/catalog');
    const url=`/api/audio/emergency-prompt?revision=${catalog.revision}&voice=${config.audioVersion}`;
    expect((await request(app).get(url).set('Cookie',cookie)).status).toBe(200);
    expect((await request(app).get(url).set('Cookie',cookie)).status).toBe(200);expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain('TWutjvRaJqAX89preB4e');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).text).toBe('Lost link, GPS, VLOS, or uncommanded input?');
    expect((await request(app).get('/api/audio/emergency-prompt?revision=old').set('Cookie',cookie)).status).toBe(409);
  });
  it('does not leak upstream errors, tokens, or credentials',async()=>{
    const fetchImpl=vi.fn(async()=>new Response('private-upstream-secret',{status:403}));const app=createApp({env,fetchImpl});const cookie=await auth(app);
    const response=await request(app).post('/api/scribe-token').set('X-OnPoint-Client','1').set('Cookie',cookie);
    expect(response.status).toBe(502);expect(response.text).not.toContain('private-upstream-secret');
  });
  it('supports a guarded n8n bridge without copying the ElevenLabs key',async()=>{
    const fetchImpl=vi.fn(async()=>Response.json({token:'single-use-token'}));
    const app=createApp({env:{...env,ELEVENLABS_API_KEY:'',N8N_VOICE_BASE_URL:'https://n8n.example/webhook/sky',N8N_VOICE_SECRET:'test-bridge-secret'},fetchImpl});const cookie=await auth(app);
    const r=await request(app).post('/api/scribe-token').set('X-OnPoint-Client','1').set('Cookie',cookie);
    expect(r.status).toBe(200);expect(fetchImpl.mock.calls[0][0]).toBe('https://n8n.example/webhook/sky/token');
    expect(fetchImpl.mock.calls[0][1].headers['X-OnPoint-Voice']).toBe('test-bridge-secret');
  });
  it('keeps the last usable catalog after a failed Trello refresh',async()=>{
    const app=createApp({env:{...env,TRELLO_API_KEY:'test',TRELLO_TOKEN:'test'},fetchImpl:vi.fn(async()=>new Response('',{status:500}))});const cookie=await auth(app);
    const before=await request(app).get('/api/catalog');const result=await request(app).post('/api/catalog/refresh').set('X-OnPoint-Client','1').set('Cookie',cookie);
    expect(result.status).toBe(502);expect((await request(app).get('/api/catalog')).body.revision).toBe(before.body.revision);
  });
});
