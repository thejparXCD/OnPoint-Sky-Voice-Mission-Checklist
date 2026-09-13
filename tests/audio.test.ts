import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio';
import { normalizeSource } from '../shared/catalog.mjs';
import raw from '../data/trello-source.json';
import type { Catalog, Config } from '../src/types';
const catalog=normalizeSource(raw) as Catalog;
const config:Config={authenticated:true,authRequired:false,voiceConfigured:true,voiceId:'TWutjvRaJqAX89preB4e',audioVersion:'test',trelloConfigured:false};
let played:string[];
class FakeContext {
  state='running'; destination={}; async resume(){};
  async decodeAudioData(bytes:ArrayBuffer){return new TextDecoder().decode(bytes);}
  createBufferSource(){return {buffer:'',playbackRate:{value:1},onended:null,connect(){},disconnect(){},stop(){},start(){played.push(this.buffer);}};}
}
describe('Audio interruption and offline cache',()=>{
  beforeEach(()=>{
    played=[];const cache=new Map<string,Response>();
    vi.stubGlobal('AudioContext',FakeContext);
    vi.stubGlobal('window',{speechSynthesis:{cancel:vi.fn(),speak:vi.fn()}});
    vi.stubGlobal('caches',{open:async()=>({match:async(key:string)=>cache.get(key)?.clone(),put:async(key:string,response:Response)=>{cache.set(key,response.clone());}})});
  });
  afterEach(()=>vi.unstubAllGlobals());
  it('never plays a stale normal item after an emergency interrupts its request',async()=>{
    let resolveOld:(r:Response)=>void=()=>{};let started:()=>void=()=>{};const firstStarted=new Promise<void>(r=>started=r);
    vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('emergency-prompt')?Promise.resolve(new Response('emergency',{headers:{'Content-Type':'audio/mpeg'}})):new Promise<Response>(resolve=>{resolveOld=resolve;started();})));
    const engine=new AudioEngine();engine.configure(catalog,config);await engine.unlock();
    const old=engine.play(catalog.platforms[0].segments[0].items[0].id);await firstStarted;
    await engine.play('emergency-prompt',true);resolveOld(new Response('obsolete item',{headers:{'Content-Type':'audio/mpeg'}}));await old;
    expect(played).toEqual(['emergency']);
  });
  it('uses cached audio with no network call after the first play',async()=>{
    const fetchMock=vi.fn(async()=>new Response('cached audio',{headers:{'Content-Type':'audio/mpeg'}}));vi.stubGlobal('fetch',fetchMock);
    const engine=new AudioEngine();engine.configure(catalog,config);await engine.unlock();await engine.play('emergency-prompt');
    fetchMock.mockRejectedValue(new Error('offline'));await engine.play('emergency-prompt');
    expect(played).toEqual(['cached audio','cached audio']);expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('stopping pending playback keeps it stopped even if the response arrives later',async()=>{
    let resolveResponse:(r:Response)=>void=()=>{};let started:()=>void=()=>{};const firstStarted=new Promise<void>(r=>started=r);
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{resolveResponse=resolve;started();})));
    const engine=new AudioEngine();engine.configure(catalog,config);await engine.unlock();const playing=engine.play('voice-test');await firstStarted;
    engine.stop();resolveResponse(new Response('late',{headers:{'Content-Type':'audio/mpeg'}}));await playing;
    expect(played).toEqual([]);expect(engine.status).toBe('idle');
  });
});
