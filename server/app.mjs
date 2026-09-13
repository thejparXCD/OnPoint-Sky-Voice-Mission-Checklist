import express from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeSource, speechIndex } from '../shared/catalog.mjs';
import { syncSource } from './trello.mjs';

const bundled = JSON.parse(readFileSync(new URL('../data/trello-source.json', import.meta.url), 'utf8'));
const equal = (a,b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
export function createApp({ env = process.env, fetchImpl = fetch } = {}) {
  const app = express();
  const production = env.NODE_ENV === 'production';
  if (production && (!env.APP_ACCESS_CODE || !env.SESSION_SECRET || !env.APP_ORIGIN?.startsWith('https://'))) throw new Error('Production requires APP_ACCESS_CODE, SESSION_SECRET, and an HTTPS APP_ORIGIN.');
  const secret = env.SESSION_SECRET || randomBytes(32).toString('hex');
  const voiceId = env.ELEVENLABS_VOICE_ID || 'TWutjvRaJqAX89preB4e';
  const modelId = env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';
  const audioVersion = createHash('sha256').update(voiceId+modelId+'0.95').digest('hex').slice(0,12);
  const bridge = env.N8N_VOICE_BASE_URL?.replace(/\/$/,'');
  const configured = Boolean(env.ELEVENLABS_API_KEY || (bridge && env.N8N_VOICE_SECRET));
  let source = bundled;
  let catalog = normalizeSource(source);
  let speech = speechIndex(catalog);
  const limits = new Map(); const audioCache = new Map(); let cacheBytes = 0; const pending = new Map();
  const sign = value => createHmac('sha256',secret).update(value).digest('base64url');
  const authenticated = req => {
    if (!env.APP_ACCESS_CODE && !production) return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const cookie = req.headers.cookie?.split('; ').find(c => c.startsWith('onpoint_session='))?.slice(16);
    if (!cookie) return false;
    const [expiry,nonce,signature] = cookie.split('.');
    return Number(expiry) > Date.now() && Number(expiry) < Date.now()+8*86400000 && Boolean(nonce && signature) && equal(sign(`${expiry}.${nonce}`),signature);
  };
  const rateLimit = (prefix,max,ms=60000) => (req,res,next) => {
    const now=Date.now();
    if (limits.size > 5000) for (const [key,entry] of limits) if (entry.until < now) limits.delete(key);
    const key = `${prefix}:${req.ip}`;
    const entry = limits.get(key);
    if (!entry || entry.until < now) limits.set(key,{n:1,until:now+ms});
    else if (++entry.n > max) return res.status(429).set('Retry-After',String(Math.ceil((entry.until-now)/1000))).json({error:'Too many requests. Please wait a moment.'});
    next();
  };
  app.disable('x-powered-by');
  app.set('trust proxy', production ? 1 : false);
  app.use((req,res,next) => {
    res.set({ 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin', 'X-Frame-Options':'DENY', 'Permissions-Policy':'microphone=(self), camera=(), geolocation=()' });
    if (production) res.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' https://api.elevenlabs.io wss://api.elevenlabs.io; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    next();
  });
  app.use('/api', (req,res,next) => {
    res.set('Cache-Control','no-store');
    if (req.headers.origin && ![env.APP_ORIGIN || 'http://localhost:5173',...(!production?['http://127.0.0.1:5173','http://localhost:3001','http://127.0.0.1:3001']:[])].includes(req.headers.origin)) return res.status(403).json({error:'Origin not allowed.'});
    if (req.method !== 'GET' && req.headers['x-onpoint-client'] !== '1') return res.status(403).json({error:'Client header required.'});
    next();
  });
  app.use(express.json({limit:'8kb'}));
  app.get('/api/health',(_req,res) => res.json({ok:true}));
  app.get('/api/config',(req,res) => res.json({ authenticated: authenticated(req), authRequired:Boolean(env.APP_ACCESS_CODE)||production, voiceConfigured:configured, voiceId, audioVersion, trelloConfigured:Boolean(env.TRELLO_API_KEY && env.TRELLO_TOKEN) }));
  app.post('/api/session',rateLimit('login',10,15*60000),(req,res) => {
    if (!env.APP_ACCESS_CODE || typeof req.body?.code !== 'string' || !equal(req.body.code,env.APP_ACCESS_CODE)) return res.status(401).json({error:'Access code not recognized.'});
    const value = `${Date.now()+7*86400000}.${randomBytes(18).toString('hex')}`;
    res.cookie('onpoint_session',`${value}.${sign(value)}`,{httpOnly:true,secure:production,sameSite:'strict',maxAge:7*86400000,path:'/'});
    res.json({ok:true});
  });
  app.delete('/api/session',(_req,res) => {res.clearCookie('onpoint_session',{path:'/',httpOnly:true,secure:production,sameSite:'strict'});res.json({ok:true});});
  app.get('/api/catalog',(_req,res) => res.json(catalog));
  app.use('/api',(req,res,next) => authenticated(req) ? next() : res.status(401).json({error:'Unlock voice with your app access code.'}));
  app.post('/api/catalog/refresh',rateLimit('trello',2),async (_req,res) => {
    try {
      const next = await syncSource(source,env,fetchImpl);
      const normalized = normalizeSource(next); // Only replace a fully validated snapshot.
      source=next;catalog=normalized;speech=speechIndex(catalog);
      res.json(catalog);
    } catch {res.status(502).json({error:'Trello refresh failed. Your existing checklist snapshot is still available.'});}
  });
  async function upstream(kind,text) {
    if (bridge) {
      const response = await fetchImpl(`${bridge}/${kind}`,{method:'POST',headers:{'Content-Type':'application/json','X-OnPoint-Voice':env.N8N_VOICE_SECRET,...(env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET ? {'CF-Access-Client-Id':env.CF_ACCESS_CLIENT_ID,'CF-Access-Client-Secret':env.CF_ACCESS_CLIENT_SECRET} : {})},body:JSON.stringify(kind === 'speech' ? {text,voiceId,modelId} : {}),signal:AbortSignal.timeout(20000)});
      return response;
    }
    return fetchImpl(kind === 'speech' ? `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128` : 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
      method:'POST',headers:{'xi-api-key':env.ELEVENLABS_API_KEY,'Content-Type':'application/json',Accept:kind === 'speech'?'audio/mpeg':'application/json'},
      ...(kind === 'speech' ? {body:JSON.stringify({text,model_id:modelId,voice_settings:{stability:0.65,similarity_boost:0.75,speed:0.95}})} : {}),signal:AbortSignal.timeout(15000),
    });
  }
  app.post('/api/scribe-token',rateLimit('token',12),async (_req,res) => {
    if (!configured) return res.status(503).json({error:'ElevenLabs is not connected yet.'});
    try {
      const upstreamResponse=await upstream('token');
      if (!upstreamResponse.ok) return res.status(502).json({error:'ElevenLabs listening is unavailable. Check credential permissions or use touch controls.'});
      const data=await upstreamResponse.json();
      if (typeof data.token !== 'string') throw new Error('Invalid token response');
      res.json({token:data.token});
    } catch {res.status(502).json({error:'Could not connect to ElevenLabs listening. Use touch controls and try again.'});}
  });
  app.get('/api/audio/:id',rateLimit('speech',180),async (req,res) => {
    const id=req.params.id;
    if (!Object.hasOwn(speech,id)) return res.status(404).json({error:'Unknown checklist item.'});
    if (req.query.revision !== catalog.revision || req.query.voice !== audioVersion) return res.status(409).json({error:'Checklist or voice changed. Refresh the app before downloading audio.'});
    if (!configured) return res.status(503).json({error:'ElevenLabs is not connected yet.'});
    const key = createHash('sha256').update(audioVersion+speech[id]).digest('hex');
    try {
      let audio=audioCache.get(key);
      if (!audio) {
        if (!pending.has(key)) {
          if (pending.size >= 6) return res.status(429).json({error:'Voice is busy. Please try again.'});
          pending.set(key,(async()=>{
            const r=await upstream('speech',speech[id]);
            if (!r.ok || !/audio\//.test(r.headers.get('content-type')||'')) throw new Error('Speech unavailable');
            const buffer=Buffer.from(await r.arrayBuffer());
            if (buffer.length < 32 || buffer.length > 8*1024*1024) throw new Error('Invalid speech response');
            while(cacheBytes+buffer.length > 32*1024*1024 && audioCache.size) { const oldest=audioCache.keys().next().value;cacheBytes-=audioCache.get(oldest).length;audioCache.delete(oldest); }
            audioCache.set(key,buffer);cacheBytes+=buffer.length;
            return buffer;
          })().finally(()=>pending.delete(key)));
        }
        audio=await pending.get(key);
      }
      res.type('audio/mpeg').send(audio);
    } catch {res.status(502).json({error:'ElevenLabs audio is unavailable. Try again or use the device voice.'});}
  });
  app.use('/api',(_req,res) => res.status(404).json({error:'API route not found.'}));
  const dist=fileURLToPath(new URL('../dist',import.meta.url));
  app.use(express.static(dist,{index:false,setHeaders:(res,path)=>{if(path.endsWith('sw.js')||path.endsWith('index.html'))res.setHeader('Cache-Control','no-cache');}}));
  app.get('/{*path}',(_req,res) => res.sendFile(`${dist}/index.html`));
  app.use((error,_req,res,_next) => res.status(error.status === 413 ? 413 : 400).json({error:'Request could not be processed.'}));
  return app;
}
