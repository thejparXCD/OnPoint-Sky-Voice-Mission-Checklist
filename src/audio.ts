import type { Catalog, Config, Platform } from './types';
import { speechIndex } from '../shared/catalog.mjs';
export type AudioStatus = 'idle' | 'loading' | 'speaking';
const AUDIO_CACHE = 'onpoint-audio-v1';
export class AudioEngine {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private speech: Record<string,string> = {};
  private revision = '';
  private config: Config | null = null;
  status: AudioStatus = 'idle';
  spokenText = '';
  rate = 1;
  useDeviceVoice = false;
  onStatus: (status: AudioStatus) => void = () => {};
  onNotice: (message: string) => void = () => {};
  configure(catalog: Catalog, config: Config | null) { this.speech=speechIndex(catalog);this.revision=catalog.revision;this.config=config; }
  private setStatus(status: AudioStatus) { this.status=status;this.onStatus(status); }
  async unlock() {
    this.context ??= new AudioContext();
    if (this.context.state !== 'running') await this.context.resume();
  }
  stop() {
    ++this.generation;
    this.controller?.abort();this.controller=null;
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
    let fallback=false;
    try {
      const cached=await this.cached(id);
      if(generation!==this.generation)return;
      if (this.useDeviceVoice || (!cached && !this.config?.voiceConfigured)) fallback=true;
      else {
        const response=cached ?? await this.download(id,AbortSignal.any([signal,AbortSignal.timeout(urgent?2200:12000)]));
        const bytes=await response.arrayBuffer();
        if(generation!==this.generation)return;
        if (!this.context || this.context.state !== 'running') throw new Error('Tap Read item to enable audio on this device.');
        const buffer=await this.context.decodeAudioData(bytes);
        if(generation!==this.generation)return;
        this.source=this.context.createBufferSource();this.source.buffer=buffer;this.source.playbackRate.value=this.rate;this.source.connect(this.context.destination);
        this.spokenText=text;this.setStatus('speaking');
        this.source.onended=()=>{if(generation===this.generation){this.spokenText='';this.setStatus('idle');}};
        this.source.start();return;
      }
    } catch (error) {
      if(generation!==this.generation || signal.aborted)return;
      this.onNotice(error instanceof Error ? error.message : 'Audio unavailable.');fallback=true;
    }
    if (generation!==this.generation)return;
    if (fallback && window.speechSynthesis) {
      this.onNotice(this.useDeviceVoice ? 'Device voice selected.' : 'Using device voice. ElevenLabs audio is unavailable.');
      const utterance=new SpeechSynthesisUtterance(text);utterance.lang='en-US';utterance.rate=this.rate*0.92;
      this.spokenText=text;this.setStatus('speaking');
      utterance.onend=()=>{if(generation===this.generation){this.spokenText='';this.setStatus('idle');}};
      utterance.onerror=()=>{if(generation===this.generation){this.spokenText='';this.setStatus('idle');this.onNotice('Audio stopped. Tap Read item to try again.');}};
      window.speechSynthesis.speak(utterance);
    } else {this.setStatus('idle');this.onNotice('Audio is unavailable. The checklist remains available on screen.');}
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
