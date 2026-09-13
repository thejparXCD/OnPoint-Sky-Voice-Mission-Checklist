import type { Catalog, Config, Platform } from './types';
import { speechIndex } from '../shared/catalog.mjs';
import { MediaOutput } from './media-output';
export type AudioStatus = 'idle' | 'loading' | 'speaking';
const AUDIO_CACHE = 'onpoint-audio-v1';
class VoiceAccessError extends Error {}
type AudioNavigator = Navigator & { audioSession?: { type: string } };
export class AudioEngine {
  private output=new MediaOutput((status,text)=>{this.spokenText=text;this.setStatus(status);},message=>this.onNotice(message));
  private controller: AbortController | null = null;
  private generation = 0;
  private speech: Record<string,string> = {};
  private revision = '';
  private config: Config | null = null;
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
    // Declare playback intent explicitly where the Audio Session API exists.
    // Use the recording category only while the microphone is in use.
    const session = (navigator as AudioNavigator).audioSession;
    const type = this.microphoneActive ? 'play-and-record' : 'playback';
    try { if (session && session.type!==type) session.type = type; } catch { /* Older browsers choose their own audio category. */ }
  }
  setMicrophoneActive(active: boolean) {
    if (this.microphoneActive === active) return;
    this.microphoneActive = active;this.setSession();
  }
  attach(element:HTMLAudioElement|null){this.output.attach(element);}
  async unlock() {this.setSession();return this.output.unlock();}
  stop() {
    ++this.generation;
    this.controller?.abort();this.controller=null;
    if(this.speechWatchdog){clearTimeout(this.speechWatchdog);this.speechWatchdog=null;}
    this.output.stop();
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
    // Call play on the persistent media element before any async cache/network work.
    const activation=this.unlock().catch(()=>{});
    let fallbackReason='ElevenLabs is not connected.';
    try {
      const cached=await this.cached(id);
      if(generation!==this.generation)return;
      if (cached || this.config?.voiceConfigured) {
        const response=cached ?? await this.download(id,AbortSignal.any([signal,AbortSignal.timeout(urgent?2200:12000)]));
        const blob=await response.blob();
        await activation;
        if(generation!==this.generation)return;
        this.setSession();
        await this.output.play(blob,text,this.rate);return;
      }
    } catch (error) {
      if(generation!==this.generation || signal.aborted)return;
      if(error instanceof VoiceAccessError){this.output.stop();this.setStatus('idle');this.onUnlockRequired();this.onNotice(error.message);return;}
      fallbackReason=error instanceof Error ? error.message : 'Audio unavailable.';
    }
    if (generation!==this.generation)return;
    this.output.stop();this.speakOnDevice(text,generation,`${fallbackReason} Trying device voice.`);
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
