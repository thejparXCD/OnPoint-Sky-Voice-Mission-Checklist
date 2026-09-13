import type { RealtimeConnection } from '@elevenlabs/client';
export type ListenStatus = 'off' | 'connecting' | 'listening' | 'error';
interface BrowserResult { isFinal: boolean; [index:number]: { transcript:string } }
interface BrowserRecognition {
  lang:string; continuous:boolean; interimResults:boolean;
  onresult:((event:{resultIndex:number;results:ArrayLike<BrowserResult>})=>void)|null;
  onstart:(()=>void)|null;onend:(()=>void)|null;onerror:((event:{error:string})=>void)|null;
  start():void;abort():void;
}
export class VoiceListener {
  private connection:RealtimeConnection|null=null;
  private browser:BrowserRecognition|null=null;
  private generation=0;
  private retry:ReturnType<typeof setTimeout>|null=null;
  private watchdog:ReturnType<typeof setTimeout>|null=null;
  private wanted=false;
  status:ListenStatus='off';
  onStatus:(status:ListenStatus)=>void=()=>{};
  onTranscript:(text:string,final:boolean)=>void=()=>{};
  onError:(message:string)=>void=()=>{};
  private set(status:ListenStatus){this.status=status;this.onStatus(status);}
  stop(){
    this.wanted=false;++this.generation;
    if(this.retry)clearTimeout(this.retry);if(this.watchdog)clearTimeout(this.watchdog);
    const connection=this.connection;this.connection=null;connection?.close();
    if(this.browser){this.browser.onend=null;this.browser.abort();this.browser=null;}
    this.set('off');
  }
  private fail(message:string){this.stop();this.set('error');this.onError(message);}
  async start(provider:'elevenlabs'|'browser'){
    this.stop();this.wanted=true;const generation=this.generation;this.set('connecting');
    if(!window.isSecureContext){this.fail('Microphone access needs HTTPS. Open the secure app address in Safari.');return;}
    this.watchdog=setTimeout(()=>{if(generation===this.generation && this.status==='connecting')this.fail('Microphone connection timed out. Tap the microphone to retry.');},15000);
    if(provider==='browser'){this.startBrowser(generation);return;}
    try {
      const { Scribe, RealtimeEvents, CommitStrategy } = await import('@elevenlabs/client');
      const response=await fetch('/api/scribe-token',{method:'POST',headers:{'X-OnPoint-Client':'1'},signal:AbortSignal.timeout(12000)});
      const data=await response.json();if(!response.ok)throw new Error(data.error || 'Listening is unavailable.');
      if(generation!==this.generation)return;
      const connection=Scribe.connect({token:data.token,modelId:'scribe_v2_realtime',commitStrategy:CommitStrategy.VAD,vadSilenceThresholdSecs:0.4,languageCode:'en',keyterms:['check','emergency','lost link','GPS','VLOS','uncommanded input','pre departure'],microphone:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      this.connection=connection;
      connection.on(RealtimeEvents.SESSION_STARTED,()=>{if(generation===this.generation){if(this.watchdog)clearTimeout(this.watchdog);this.set('listening');}});
      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT,data=>{if(generation===this.generation)this.onTranscript(data.text,false);});
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT,data=>{if(generation===this.generation)this.onTranscript(data.text,true);});
      connection.on(RealtimeEvents.ERROR,()=>{if(generation===this.generation)this.fail('Listening stopped. Check microphone permission and ElevenLabs availability, then tap to reconnect.');});
      connection.on(RealtimeEvents.CLOSE,()=>{if(generation===this.generation&&this.wanted)this.fail('Voice connection ended. Touch controls remain available. Tap the microphone to reconnect.');});
    }catch(error){if(generation===this.generation)this.fail(error instanceof Error?error.message:'Could not start listening.');}
  }
  private startBrowser(generation:number){
    const win=window as unknown as {SpeechRecognition?:new()=>BrowserRecognition;webkitSpeechRecognition?:new()=>BrowserRecognition};
    const Constructor=win.SpeechRecognition || win.webkitSpeechRecognition;
    if(!Constructor){this.fail('This browser does not support device recognition. Choose ElevenLabs listening or use touch controls.');return;}
    const recognition=new Constructor();this.browser=recognition;recognition.lang='en-US';recognition.continuous=true;recognition.interimResults=true;
    recognition.onstart=()=>{if(generation===this.generation){if(this.watchdog)clearTimeout(this.watchdog);this.set('listening');}};
    recognition.onresult=event=>{if(generation!==this.generation)return;for(let i=event.resultIndex;i<event.results.length;i++)this.onTranscript(event.results[i][0].transcript,event.results[i].isFinal);};
    recognition.onerror=event=>{if(generation===this.generation && !['no-speech','aborted'].includes(event.error))this.fail(`Device recognition stopped (${event.error}). Check microphone permission or choose ElevenLabs listening.`);};
    recognition.onend=()=>{
      if(this.wanted&&generation===this.generation){
        this.set('connecting');
        this.retry=setTimeout(()=>{if(generation===this.generation){try{recognition.start();}catch{this.fail('Tap the microphone to restart device recognition.');}}},400);
      }
    };
    try{recognition.start();}catch{this.fail('Could not start device recognition. Tap the microphone to retry.');}
  }
}
