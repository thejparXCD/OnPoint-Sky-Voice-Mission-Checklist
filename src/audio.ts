import type { Catalog, Config, Platform } from './types';
import { speechIndex } from '../shared/catalog.mjs';
export type AudioStatus = 'idle' | 'loading' | 'speaking';
const AUDIO_CACHE = 'onpoint-audio-v1';
class VoiceAccessError extends Error {}
class PlaybackBlockedError extends Error {}
const PLAYBACK_HELP = 'Audio is paused by your device. Tap Read item or Test voice to enable sound.';
type AudioNavigator = Navigator & { audioSession?: { type: string } };
export class AudioEngine {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private speech: Record<string,string> = {};
  private revision = '';
  private config: Config | null = null;
  private resuming: Promise<void> | null = null;
  private microphoneActive = false;
  private speechWatchdog: ReturnType<typeof setTimeout> | null = null;
  status: AudioStatus = 'idle';
  spokenText = '';
  rate = 1;
  useDeviceVoice = false;
  onStatus: (status: AudioStatus) => void = () => {};
  onNotice: (message: string) => void = () => {};
  onUnlockRequired: () => void = () => {};
  configure(catalog: Catalog, config: Config | null) { this.speech=speechIndex(catalog);this.revision=catalog.revision;this.config=config; }
  private setStatus(status: AudioStatus) { this.status=status;this.onStatus(status); }
  private setSession() {
    // Web Audio defaults to ambient on iPhone, which obeys the Silent switch.
    // Use the recording category only while the microphone is in use.
    const session = (navigator as AudioNavigator).audioSession;
    const type = this.microphoneActive ? 'play-and-record' : 'playback';
    try { if (session && session.type!==type) session.type = type; } catch { /* Older browsers choose their own audio category. */ }
  }
  setMicrophoneActive(active: boolean) {
    if (this.microphoneActive === active) return;
    this.microphoneActive = active;this.setSession();
  }
  async unlock() {
    this.setSession();
    if(!this.context){
      const context=new AudioContext();this.context=context;
      context.onstatechange=()=>{
        if(context.state==='running'||!this.source||this.status!=='speaking')return;
        const generation=this.generation;this.setStatus('loading');
        void this.unlock().then(()=>{
          if(generation===this.generation&&this.source){this.setStatus('speaking');}
        }).catch(()=>{
          if(generation===this.generation){this.stop();this.onNotice(PLAYBACK_HELP);}
        });
      };
    }
    if (this.context.state === 'running') return;
    if (!this.resuming) {
      const context = this.context;
      this.resuming = new Promise<void>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new PlaybackBlockedError(PLAYBACK_HELP)),2500);
        context.resume().then(()=>{
          clearTimeout(timeout);
          if(context.state==='running')resolve();else reject(new PlaybackBlockedError(PLAYBACK_HELP));
        },()=>{clearTimeout(timeout);reject(new PlaybackBlockedError(PLAYBACK_HELP));});
      }).finally(()=>{this.resuming=null;});
    }
    await this.resuming;
  }
  stop() {
    ++this.generation;
    this.controller?.abort();this.controller=null;
    if(this.speechWatchdog){clearTimeout(this.speechWatchdog);this.speechWatchdog=null;}
    if(this.source){ this.source.onended=null;try {this.source.stop();}catch{/* Already ended. */}this.source.disconnect();this.source=null; }
    window.speechSynthesis?.cancel();
    this.spokenText='';this.setStatus('idle');
  }
  url(id: string) { return `/api/audio/${encodeURIComponent(id)}?revision=${this.revision}&voice=${this.config?.audioVersion ?? 'unconfigured'}`; }
  async cached(id: string) {
    try {return await (await caches.open(AUDIO_CACHE)).match(this.url(id));}catch{return undefined;}
  }
  async download(id: string, signal?: AbortSignal): Promise<Response> {
    const cached=await this.cached(id);if(cached)return cached;
    const response=await fetch(this.url(id),{signal});
    if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/')) {
      const error=await response.json().catch(()=>({}));
      if(response.status===401)throw new VoiceAccessError('Unlock voice with your app access code in settings, then tap Test voice.');
      throw new Error(error.error || 'Voice download failed.');
    }
    try {await (await caches.open(AUDIO_CACHE)).put(this.url(id),response.clone());}catch{/* Audio can still play if storage is full. */}
    return response;
  }
  async play(id: string, urgent=false) {
    this.stop();
    const generation=this.generation;const text=this.speech[id];if(!text)return;
    this.setStatus('loading');
    this.controller=new AbortController();
    const signal=this.controller.signal;
    // Keep an explicitly selected device voice inside the original tap gesture.
    if(this.useDeviceVoice){this.speakOnDevice(text,generation,'Device voice selected.');return;}
    let fallbackReason='ElevenLabs is not connected.';
    try {
      const cached=await this.cached(id);
      if(generation!==this.generation)return;
      if (cached || this.config?.voiceConfigured) {
        const response=cached ?? await this.download(id,AbortSignal.any([signal,AbortSignal.timeout(urgent?2200:12000)]));
        const bytes=await response.arrayBuffer();
        if(generation!==this.generation)return;
        // Await the tap's pending resume, and recover after a phone/mic interruption.
        await this.unlock();
        if(generation!==this.generation)return;
        const context=this.context!;
        const buffer=await context.decodeAudioData(bytes);
        await this.unlock();
        if(generation!==this.generation)return;
        const source=context.createBufferSource();this.source=source;source.buffer=buffer;source.playbackRate.value=this.rate;source.connect(context.destination);
        source.onended=()=>{source.disconnect();if(generation===this.generation){this.source=null;this.spokenText='';this.setStatus('idle');}};
        source.start();this.spokenText=text;this.setStatus('speaking');return;
      }
    } catch (error) {
      if(generation!==this.generation || signal.aborted)return;
      if(error instanceof VoiceAccessError){this.setStatus('idle');this.onUnlockRequired();this.onNotice(error.message);return;}
      if(error instanceof PlaybackBlockedError){this.setStatus('idle');this.onNotice(error.message);return;}
      fallbackReason=error instanceof Error ? error.message : 'Audio unavailable.';
    }
    if (generation!==this.generation)return;
    this.speakOnDevice(text,generation,`${fallbackReason} Trying device voice.`);
  }
  private speakOnDevice(text:string,generation:number,notice:string) {
    this.setSession();
    if (window.speechSynthesis) {
      this.onNotice(notice);
      const utterance=new SpeechSynthesisUtterance(text);utterance.lang='en-US';utterance.rate=this.rate*0.92;
      const clearWatchdog=()=>{if(this.speechWatchdog){clearTimeout(this.speechWatchdog);this.speechWatchdog=null;}};
      const fail=()=>{if(generation===this.generation){this.stop();this.onNotice(`${notice} Device speech did not start or was interrupted. Tap Read item or Test voice to retry.`);}};
      utterance.onstart=()=>{if(generation===this.generation){clearWatchdog();this.spokenText=text;this.setStatus('speaking');}};
      utterance.onend=()=>{if(generation===this.generation){clearWatchdog();this.spokenText='';this.setStatus('idle');}};
      utterance.onerror=fail;
      this.speechWatchdog=setTimeout(fail,3000);
      try {window.speechSynthesis.resume();window.speechSynthesis.speak(utterance);}catch{fail();}
    } else {this.setStatus('idle');this.onNotice(`${notice} Device speech is unavailable on this browser.`);}
  }
  async prepare(platform: Platform, onProgress: (done:number,total:number)=>void, signal:AbortSignal) {
    const ids=['emergency-prompt','emergency-complete','segment-complete','voice-test',...platform.missingEmergencies.map(e=>`missing-${platform.id}-${e}`),...platform.segments.flatMap(s=>s.items.map(i=>i.id))];
    let done=0;
    for(const id of ids) {if(signal.aborted)throw new DOMException('Cancelled','AbortError');await this.download(id,signal);onProgress(++done,ids.length);}
    // Verify persistent storage, not just successful network requests.
    if (!(await Promise.all(ids.map(id=>this.cached(id)))).every(Boolean)) throw new Error('Audio played, but device storage is full. Offline pack was not saved.');
  }
  async preloadEmergencies(platform: Platform) {
    if(!this.config?.voiceConfigured || !this.config.authenticated)return;
    const ids=['emergency-prompt',...platform.segments.filter(s=>s.emergency).map(s=>s.items[0].id)];
    for(const id of ids) {try {await this.download(id,AbortSignal.timeout(15000));}catch{return;}}
  }
}
