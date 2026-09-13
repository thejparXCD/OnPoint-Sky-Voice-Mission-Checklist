import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio';
import { normalizeSource } from '../shared/catalog.mjs';
import raw from '../data/trello-source.json';
import type { Catalog, Config } from '../src/types';
const catalog=normalizeSource(raw) as Catalog;
const config:Config={authenticated:true,authRequired:false,voiceConfigured:true,voiceId:'TWutjvRaJqAX89preB4e',audioVersion:'test',trelloConfigured:false};
let played:string[];
let contexts:FakeContext[];
let resume: (context:FakeContext)=>Promise<void>;
class FakeContext {
  state='running'; destination={};
  onstatechange: (()=>void)|null=null;
  constructor(){contexts.push(this);}
  resume(){return resume(this);}
  async decodeAudioData(bytes:ArrayBuffer){return new TextDecoder().decode(bytes);}
  createBufferSource(){return {buffer:'',playbackRate:{value:1},onended:null,connect(){},disconnect(){},stop(){},start(){played.push(this.buffer);}};}
}
describe('Audio interruption and offline cache',()=>{
  beforeEach(()=>{
    played=[];contexts=[];resume=async context=>{context.state='running';};const cache=new Map<string,Response>();
    vi.stubGlobal('AudioContext',FakeContext);
    vi.stubGlobal('navigator',{audioSession:{type:'auto'}});
    vi.stubGlobal('window',{speechSynthesis:{cancel:vi.fn(),speak:vi.fn(),resume:vi.fn()}});
    vi.stubGlobal('SpeechSynthesisUtterance',class {constructor(public text:string){}});
    vi.stubGlobal('caches',{open:async()=>({match:async(key:string)=>cache.get(key)?.clone(),put:async(key:string,response:Response)=>{cache.set(key,response.clone());}})});
  });
  afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
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
  it('uses an audible iPhone audio category and switches for microphone capture',async()=>{
    const engine=new AudioEngine();await engine.unlock();
    const session=(navigator as unknown as {audioSession:{type:string}}).audioSession;
    expect(session.type).toBe('playback');
    engine.setMicrophoneActive(true);await engine.unlock();expect(session.type).toBe('play-and-record');
    engine.setMicrophoneActive(false);expect(session.type).toBe('playback');
  });
  it('still plays on browsers without the optional Audio Session API',async()=>{
    vi.stubGlobal('navigator',{});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('voice',{headers:{'Content-Type':'audio/mpeg'}})));
    const engine=new AudioEngine();engine.configure(catalog,config);await engine.unlock();await engine.play('voice-test');
    expect(played).toEqual(['voice']);
  });
  it('waits for the tap to resume audio instead of failing on a fast cache hit',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('voice',{headers:{'Content-Type':'audio/mpeg'}})));
    const engine=new AudioEngine();engine.configure(catalog,config);await engine.unlock();await engine.download('voice-test');
    contexts[0].state='suspended';
    let finish=()=>{};resume=context=>new Promise<void>(resolve=>{finish=()=>{context.state='running';resolve();};});
    const unlocking=engine.unlock();const playing=engine.play('voice-test');
    expect(engine.status).toBe('loading');expect(played).toEqual([]);
    finish();await unlocking;await playing;
    expect(played).toEqual(['voice']);expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });
  it('recovers an interrupted audio context before the next voice command',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('voice',{headers:{'Content-Type':'audio/mpeg'}})));
    const engine=new AudioEngine();engine.configure(catalog,config);await engine.unlock();
    contexts[0].state='interrupted';await engine.play('voice-test');
    expect(contexts[0].state).toBe('running');expect(played).toEqual(['voice']);
  });
  it('does not play an obsolete item after interruption while audio resumes',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(url.includes('emergency-prompt')?'emergency':'old',{headers:{'Content-Type':'audio/mpeg'}})));
    const engine=new AudioEngine();engine.configure(catalog,config);await engine.unlock();await engine.download('voice-test');await engine.download('emergency-prompt');
    contexts[0].state='suspended';
    let finish=()=>{};let notify=()=>{};const started=new Promise<void>(r=>notify=r);
    resume=context=>new Promise<void>(resolve=>{finish=()=>{context.state='running';resolve();};notify();});
    const old=engine.play('voice-test');await started;
    const emergency=engine.play('emergency-prompt',true);finish();await Promise.all([old,emergency]);
    expect(played).toEqual(['emergency']);
  });
  it('reports blocked playback without claiming to read or hiding it with fallback',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('voice',{headers:{'Content-Type':'audio/mpeg'}})));
    const engine=new AudioEngine();engine.configure(catalog,config);await engine.unlock();engine.onNotice=vi.fn();
    contexts[0].state='suspended';resume=async()=>{throw new DOMException('Not allowed','NotAllowedError');};
    await engine.play('voice-test');
    expect(engine.status).toBe('idle');expect(played).toEqual([]);expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
    expect(engine.onNotice).toHaveBeenCalledWith(expect.stringContaining('Tap Read item or Test voice'));
  });
  it('reports a suspended output during reading if the device will not resume',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('voice',{headers:{'Content-Type':'audio/mpeg'}})));
    const engine=new AudioEngine();engine.configure(catalog,config);await engine.unlock();await engine.play('voice-test');engine.onNotice=vi.fn();
    resume=async()=>{throw new DOMException('Not allowed','NotAllowedError');};contexts[0].state='interrupted';contexts[0].onstatechange?.();
    expect(engine.status).toBe('loading');
    await vi.waitFor(()=>expect(engine.status).toBe('idle'));
    expect(engine.onNotice).toHaveBeenCalledWith(expect.stringContaining('Tap Read item or Test voice'));
  });
  it('times out a pending device resume without leaving audio stuck loading',async()=>{
    vi.useFakeTimers();const engine=new AudioEngine();await engine.unlock();contexts[0].state='suspended';resume=()=>new Promise(()=>{});
    const result=expect(engine.unlock()).rejects.toThrow('Tap Read item or Test voice');
    await vi.advanceTimersByTimeAsync(2500);await result;
  });
  it('asks for the access code on an expired session without losing the reason',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'Unlock voice'},{status:401})));
    const engine=new AudioEngine();engine.configure(catalog,config);engine.onUnlockRequired=vi.fn();engine.onNotice=vi.fn();
    await engine.play('voice-test');
    expect(engine.onUnlockRequired).toHaveBeenCalledOnce();expect(engine.onNotice).toHaveBeenCalledWith(expect.stringContaining('app access code'));
    expect(engine.status).toBe('idle');expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });
  it('starts selected device speech in the tap and shows Reading only after onstart',async()=>{
    const engine=new AudioEngine();engine.configure(catalog,config);engine.useDeviceVoice=true;
    const playing=engine.play('voice-test');
    expect(window.speechSynthesis.speak).toHaveBeenCalledOnce();expect(engine.status).toBe('loading');
    const utterance=vi.mocked(window.speechSynthesis.speak).mock.calls[0][0];
    utterance.onstart?.(new Event('start') as SpeechSynthesisEvent);
    expect(engine.status).toBe('speaking');
    utterance.onend?.(new Event('end') as SpeechSynthesisEvent);await playing;
    expect(engine.status).toBe('idle');
  });
  it('detects device speech that never starts instead of remaining silently in Reading',async()=>{
    vi.useFakeTimers();const engine=new AudioEngine();engine.configure(catalog,config);engine.useDeviceVoice=true;engine.onNotice=vi.fn();
    await engine.play('voice-test');await vi.advanceTimersByTimeAsync(3000);
    expect(engine.status).toBe('idle');expect(engine.onNotice).toHaveBeenLastCalledWith(expect.stringContaining('Device speech did not start'));
  });
});
