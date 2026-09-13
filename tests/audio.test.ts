import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio';
import { normalizeSource } from '../shared/catalog.mjs';
import raw from '../data/trello-source.json';
import type { Catalog, Config } from '../src/types';
const catalog=normalizeSource(raw) as Catalog;
const config:Config={authenticated:true,authRequired:false,voiceConfigured:true,voiceId:'TWutjvRaJqAX89preB4e',audioVersion:'test',trelloConfigured:false};
let played:string[], blobs:Map<string,Blob>, nextUrl:number;
let playAudio:(media:FakeMedia,blob:Blob)=>Promise<void>;
let playSilence:(media:FakeMedia)=>Promise<void>;
class FakeMedia {
  src='';paused=true;muted=false;volume=1;playbackRate=1;playCalls:string[]=[];
  onplaying:(()=>void)|null=null;onpause:(()=>void)|null=null;onended:(()=>void)|null=null;
  onerror:(()=>void)|null=null;onwaiting:(()=>void)|null=null;
  play(){this.playCalls.push(this.src);const blob=blobs.get(this.src);if(!blob)return Promise.reject(new DOMException('No source','NotSupportedError'));return blob.type==='audio/wav'?playSilence(this):playAudio(this,blob);}
  pause(){this.paused=true;this.onpause?.();}
  removeAttribute(name:string){if(name==='src')this.src='';}
  load(){}
}
function fixture(){const media=new FakeMedia();const engine=new AudioEngine();engine.attach(media as unknown as HTMLAudioElement);engine.configure(catalog,config);engine.onNotice=vi.fn();return {engine,media};}
const response=(text:string)=>new Response(text,{headers:{'Content-Type':'audio/mpeg'}});
describe('Media readout, interruption and offline packs',()=>{
  beforeEach(()=>{
    played=[];blobs=new Map();nextUrl=0;const cache=new Map<string,Response>();
    vi.spyOn(URL,'createObjectURL').mockImplementation(blob=>{const url=`blob:audio-${++nextUrl}`;blobs.set(url,blob as Blob);return url;});
    vi.spyOn(URL,'revokeObjectURL').mockImplementation(url=>{blobs.delete(url);});
    playSilence=async media=>{media.paused=false;};
    playAudio=async(media,blob)=>{played.push(await blob.text());media.paused=false;media.onplaying?.();};
    vi.stubGlobal('AudioContext',class {constructor(){throw new Error('Web Audio must not be used for output');}});
    vi.stubGlobal('navigator',{audioSession:{type:'auto'}});
    vi.stubGlobal('window',{speechSynthesis:{cancel:vi.fn(),speak:vi.fn(),resume:vi.fn()}});
    vi.stubGlobal('SpeechSynthesisUtterance',class {constructor(public text:string){}});
    vi.stubGlobal('caches',{open:async()=>({match:async(key:string)=>cache.get(key)?.clone(),put:async(key:string,r:Response)=>{cache.set(key,r.clone());}})});
    vi.stubGlobal('fetch',vi.fn(async()=>response('voice')));
  });
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
  it('activates the same native player during the tap, before async loading',async()=>{
    const {engine,media}=fixture();const playing=engine.play('voice-test');
    expect(media.playCalls).toHaveLength(1);expect(blobs.get(media.src)?.type).toBe('audio/wav');
    await playing;
    expect(media.playCalls).toHaveLength(2);expect(played).toEqual(['voice']);expect(engine.status).toBe('speaking');
    expect(media.muted).toBe(false);expect(media.volume).toBe(1);expect(blobs.size).toBe(1);
  });
  it('reuses downloaded recordings offline, including an expired online session',async()=>{
    const {engine}=fixture();await engine.play('voice-test');
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));engine.configure(catalog,{...config,authenticated:false});await engine.play('voice-test');
    expect(played).toEqual(['voice','voice']);expect(fetch).toHaveBeenCalledTimes(1);expect(blobs.size).toBe(1);
  });
  it('works without Audio Session support and does not construct an AudioContext',async()=>{
    vi.stubGlobal('navigator',{});const {engine}=fixture();await engine.play('voice-test');expect(played).toEqual(['voice']);
  });
  it('selects playback and microphone categories without replacing the player',async()=>{
    const {engine,media}=fixture();await engine.unlock();
    const session=(navigator as unknown as {audioSession:{type:string}}).audioSession;expect(session.type).toBe('playback');
    engine.setMicrophoneActive(true);await engine.play('voice-test');expect(session.type).toBe('play-and-record');
    engine.setMicrophoneActive(false);expect(session.type).toBe('playback');expect(media.playCalls.length).toBeGreaterThan(1);
  });
  it('never plays a stale normal response after emergency interrupts it',async()=>{
    let resolveOld:(r:Response)=>void=()=>{},started:()=>void=()=>{};const firstStarted=new Promise<void>(r=>started=r);
    vi.mocked(fetch).mockImplementation(url=>String(url).includes('emergency-prompt')?Promise.resolve(response('emergency')):new Promise<Response>(resolve=>{resolveOld=resolve;started();}));
    const {engine}=fixture();const old=engine.play(catalog.platforms[0].segments[0].items[0].id);await firstStarted;
    await engine.play('emergency-prompt',true);resolveOld(response('obsolete'));await old;
    expect(played).toEqual(['emergency']);
  });
  it('stops an in-flight request and clears the native replay source',async()=>{
    let resolveResponse:(r:Response)=>void=()=>{},started:()=>void=()=>{};const firstStarted=new Promise<void>(r=>started=r);
    vi.mocked(fetch).mockImplementation(()=>new Promise<Response>(resolve=>{resolveResponse=resolve;started();}));
    const {engine,media}=fixture();const playing=engine.play('voice-test');await firstStarted;
    engine.stop();resolveResponse(response('late'));await playing;
    expect(played).toEqual([]);expect(media.src).toBe('');expect(engine.status).toBe('idle');expect(blobs.size).toBe(0);
  });
  it('ignores an old play promise and its handlers after an emergency takes over',async()=>{
    const {engine,media}=fixture();await engine.unlock();
    let resolveOld=()=>{},started=()=>{};let stalePlaying:(()=>void)|null=null;const firstStarted=new Promise<void>(r=>started=r);
    playAudio=async(m,blob)=>{const text=await blob.text();if(text==='old'){stalePlaying=m.onplaying;started();return new Promise<void>(r=>resolveOld=r);}played.push(text);m.paused=false;m.onplaying?.();};
    vi.mocked(fetch).mockImplementation(async url=>response(String(url).includes('emergency-prompt')?'emergency':'old'));
    const old=engine.play('voice-test');await firstStarted;
    await engine.play('emergency-prompt',true);const emergencyUrl=media.src;resolveOld();(stalePlaying as (()=>void)|null)?.();await old;
    expect(media.src).toBe(emergencyUrl);expect(engine.spokenText).toContain('Lost link');expect(played).toEqual(['emergency']);expect(engine.status).toBe('speaking');
  });
  it('keeps blocked audio available for a direct native Play tap',async()=>{
    const {engine,media}=fixture();playAudio=async()=>{throw new DOMException('Gesture needed','NotAllowedError');};
    await engine.play('voice-test');expect(engine.status).toBe('idle');expect(engine.onNotice).toHaveBeenCalledWith(expect.stringContaining('Tap Play'));
    const source=media.src;expect(blobs.get(source)?.type).toBe('audio/mpeg');expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
    playAudio=async m=>{m.paused=false;m.onplaying?.();};await media.play();
    expect(engine.status).toBe('speaking');expect(media.src).toBe(source);expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reflects native pause, resume and end events without advancing the checklist',async()=>{
    const {engine,media}=fixture();await engine.play('voice-test');const source=media.src;
    media.pause();expect(engine.status).toBe('idle');expect(engine.spokenText).toBe('');
    await media.play();expect(engine.status).toBe('speaking');
    media.onended?.();expect(engine.status).toBe('idle');expect(media.src).toBe(source);expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('still tries real audio if the priming play was blocked',async()=>{
    playSilence=async()=>{throw new DOMException('Blocked','NotAllowedError');};
    const {engine}=fixture();await engine.play('voice-test');expect(played).toEqual(['voice']);expect(engine.status).toBe('speaking');
  });
  it('reports a play call that never settles and allows a direct retry',async()=>{
    const {engine,media}=fixture();await engine.unlock();vi.useFakeTimers();let started=()=>{};const firstStarted=new Promise<void>(r=>started=r);
    playAudio=()=>{started();return new Promise(()=>{});};const playing=engine.play('voice-test');await firstStarted;
    await vi.advanceTimersByTimeAsync(5000);await playing;
    expect(engine.status).toBe('idle');expect(media.paused).toBe(true);expect(media.src).not.toBe('');expect(engine.onNotice).toHaveBeenCalledWith(expect.stringContaining('Tap Play'));
  });
  it('detects stalled playback and clears its waiting timer when stopped',async()=>{
    const {engine,media}=fixture();await engine.play('voice-test');vi.useFakeTimers();media.onwaiting?.();
    expect(engine.status).toBe('loading');await vi.advanceTimersByTimeAsync(5000);expect(engine.status).toBe('idle');expect(engine.onNotice).toHaveBeenCalledWith(expect.stringContaining('buffering'));
    media.onwaiting?.();engine.stop();vi.mocked(engine.onNotice).mockClear();await vi.advanceTimersByTimeAsync(5000);expect(engine.onNotice).not.toHaveBeenCalled();
  });
  it('retains the access-code explanation on a failed uncached request',async()=>{
    vi.mocked(fetch).mockResolvedValue(Response.json({error:'Unlock voice'},{status:401}));const {engine}=fixture();engine.onUnlockRequired=vi.fn();
    await engine.play('voice-test');expect(engine.onUnlockRequired).toHaveBeenCalledOnce();expect(engine.onNotice).toHaveBeenCalledWith(expect.stringContaining('app access code'));
    expect(engine.status).toBe('idle');expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });
  it('starts selected device speech in the tap and waits for its start event',async()=>{
    const {engine,media}=fixture();engine.useDeviceVoice=true;const playing=engine.play('voice-test');
    expect(window.speechSynthesis.speak).toHaveBeenCalledOnce();expect(engine.status).toBe('loading');expect(media.playCalls).toHaveLength(0);
    const utterance=vi.mocked(window.speechSynthesis.speak).mock.calls[0][0];utterance.onstart?.(new Event('start') as SpeechSynthesisEvent);expect(engine.status).toBe('speaking');
    utterance.onend?.(new Event('end') as SpeechSynthesisEvent);await playing;expect(engine.status).toBe('idle');
  });
  it('detects device speech that never starts',async()=>{
    vi.useFakeTimers();const {engine}=fixture();engine.useDeviceVoice=true;
    await engine.play('voice-test');await vi.advanceTimersByTimeAsync(3000);expect(engine.status).toBe('idle');expect(engine.onNotice).toHaveBeenLastCalledWith(expect.stringContaining('Device speech did not start'));
  });
});
