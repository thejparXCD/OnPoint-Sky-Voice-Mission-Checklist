export type OutputStatus = 'idle' | 'loading' | 'speaking';
const PLAY_HELP = 'Sound is ready. Tap Play in the Checklist audio player, or tap Read item / Repeat to enable playback.';

// A short, silent PCM recording unlocks this same media element inside the tap.
// Unlike an AudioContext, HTML audio uses the device's media playback path.
function silence() {
  const samples=1103;const bytes=new ArrayBuffer(44+samples*2);const view=new DataView(bytes);
  const text=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
  text(0,'RIFF');view.setUint32(4,bytes.byteLength-8,true);text(8,'WAVE');text(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,22050,true);view.setUint32(28,44100,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  text(36,'data');view.setUint32(40,samples*2,true);
  return new Blob([bytes],{type:'audio/wav'});
}

export class MediaOutput {
  private element:HTMLAudioElement|null=null;
  private generation=0;
  private controller:AbortController|null=null;
  private objectUrl:string|null=null;
  private priming:Promise<void>|null=null;
  private unlocked=false;
  private waiting:ReturnType<typeof setTimeout>|null=null;
  constructor(private onState:(status:OutputStatus,text:string)=>void,private onNotice:(message:string)=>void){}

  attach(element:HTMLAudioElement|null){
    if(this.element===element)return;
    this.stop();this.element=element;this.unlocked=false;
  }
  private clearWait(){if(this.waiting){clearTimeout(this.waiting);this.waiting=null;}}
  stop(){
    ++this.generation;this.controller?.abort();this.controller=null;this.priming=null;this.clearWait();
    const media=this.element;
    if(media){
      media.onplaying=null;media.onpause=null;media.onended=null;media.onerror=null;media.onwaiting=null;
      media.pause();media.removeAttribute('src');media.load();
    }
    if(this.objectUrl){URL.revokeObjectURL(this.objectUrl);this.objectUrl=null;}
    this.onState('idle','');
  }
  private requireElement(){if(!this.element)throw new Error('Audio player is not ready. Reload the app.');return this.element;}
  private start(media:HTMLAudioElement,signal:AbortSignal,timeoutMs:number){
    return new Promise<void>((resolve,reject)=>{
      let settled=false;
      const finish=(error?:unknown)=>{
        if(settled)return;settled=true;clearTimeout(timeout);signal.removeEventListener('abort',abort);
        if(error)reject(error);else resolve();
      };
      const abort=()=>finish(new DOMException('Playback cancelled','AbortError'));
      const timeout=setTimeout(()=>finish(new DOMException('Playback did not start','TimeoutError')),timeoutMs);
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted){abort();return;}
      try{media.play().then(()=>finish(),finish);}catch(error){finish(error);}
    });
  }
  unlock():Promise<void>{
    if(this.unlocked)return Promise.resolve();
    if(this.priming)return this.priming;
    const media=this.requireElement();const generation=this.generation;
    const controller=new AbortController();this.controller=controller;
    const url=URL.createObjectURL(silence());this.objectUrl=url;
    media.muted=false;media.volume=1;media.src=url;
    const priming=this.start(media,controller.signal,1500).then(()=>{
      if(generation===this.generation)this.unlocked=true;
    }).finally(()=>{
      if(generation===this.generation){
        media.pause();media.removeAttribute('src');media.load();
        if(this.objectUrl===url){URL.revokeObjectURL(url);this.objectUrl=null;}
        this.priming=null;this.controller=null;
      }
    });
    this.priming=priming;return priming;
  }
  async play(blob:Blob,text:string,rate:number){
    this.stop();const generation=this.generation;const media=this.requireElement();
    const controller=new AbortController();this.controller=controller;
    const url=URL.createObjectURL(blob);this.objectUrl=url;
    const current=()=>generation===this.generation;
    const blocked=(message=PLAY_HELP)=>{
      if(!current())return;this.clearWait();media.pause();this.onState('idle','');this.onNotice(message);
    };
    media.onplaying=()=>{
      if(!current())return;this.clearWait();this.unlocked=true;this.onState('speaking',text);
    };
    media.onpause=()=>{if(current()){this.clearWait();this.onState('idle','');}};
    media.onended=()=>{if(current()){this.clearWait();this.onState('idle','');}};
    media.onerror=()=>blocked('The recording could not be played. Tap Read item / Repeat to retry.');
    media.onwaiting=()=>{
      if(!current())return;this.onState('loading','');this.clearWait();
      this.waiting=setTimeout(()=>blocked('Audio stopped buffering. Tap Play in the Checklist audio player to retry.'),5000);
    };
    media.src=url;media.muted=false;media.volume=1;media.playbackRate=rate;
    this.onState('loading','');
    try{
      await this.start(media,controller.signal,5000);
      if(current()&&!media.paused){this.unlocked=true;this.onState('speaking',text);}
    }catch(error){
      if(!current()||controller.signal.aborted)return;
      // Keep the current blob attached so the native Play button can recover
      // directly inside a user gesture, without another fetch or decode.
      this.unlocked=false;
      blocked(error instanceof DOMException&&error.name==='NotSupportedError'
        ? 'This recording could not be decoded. Tap Read item / Repeat to retry.' : PLAY_HELP);
    }
  }
}
