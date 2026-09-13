import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Download, Headphones, Mic, MicOff, Pause, Play, Radio, RotateCcw, Settings2, ShieldAlert, Volume2, Wifi, WifiOff, X } from 'lucide-react';
import rawSource from '../data/trello-source.json';
import { EMERGENCIES, normalizeSource } from '../shared/catalog.mjs';
import { initialState, normalizeSpeech, platformFor, restoreState, segmentFor, TranscriptGate, transition } from './mission';
import { AudioEngine, type AudioStatus } from './audio';
import { VoiceListener, type ListenStatus } from './listener';
import type { Action, Catalog, Config, EmergencyKey, MissionState } from './types';
import { version } from '../package.json';

const bundled = normalizeSource(rawSource) as Catalog;
const storage = { get(key:string){try{return localStorage.getItem(key);}catch{return null;}}, set(key:string,value:string){try{localStorage.setItem(key,value);return true;}catch{return false;}} };
function savedCatalog():Catalog {try{const saved=JSON.parse(storage.get('onpoint-catalog')||'null');return saved?.platforms?.length && saved?.revision ? saved : bundled;}catch{return bundled;}}
const pad = (n:number) => String(n).padStart(2,'0');
function DroneMark(){return <svg className="drone-mark" viewBox="0 0 180 130" aria-hidden="true"><g fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="90" cy="65" r="56" strokeDasharray="2 7" opacity=".35"/><path d="M90 0v20m0 90v20M15 65H0m165 0h15" opacity=".4"/><path d="m76 54-34-25m62 25 34-25M77 74l-36 24m62-24 35 24" strokeWidth="7"/><ellipse cx="38" cy="27" rx="25" ry="10"/><ellipse cx="142" cy="27" rx="25" ry="10"/><ellipse cx="38" cy="103" rx="25" ry="10"/><ellipse cx="142" cy="103" rx="25" ry="10"/><path d="m76 41 28 0 8 25-13 29H81L68 66Z" fill="currentColor" fillOpacity=".08"/><path d="M83 57h14v17H83zM85 84h10"/></g></svg>;}
export default function App(){
  const [catalog,setCatalog]=useState<Catalog>(savedCatalog);
  const [mission,setMission]=useState<MissionState>(()=>restoreState(savedCatalog(),storage.get('onpoint-mission')));
  const [config,setConfig]=useState<Config|null>(()=>{try{return JSON.parse(storage.get('onpoint-config')||'null');}catch{return null;}});
  const [audioStatus,setAudioStatus]=useState<AudioStatus>('idle');
  const [listenStatus,setListenStatus]=useState<ListenStatus>('off');
  const [notice,setNotice]=useState('');
  const [heard,setHeard]=useState('');
  const [online,setOnline]=useState(navigator.onLine);
  const [settings,setSettings]=useState(false);
  const [help,setHelp]=useState(false);
  const [segmentsOpen,setSegmentsOpen]=useState(false);
  const [provider,setProvider]=useState<'elevenlabs'|'browser'>('elevenlabs');
  const [deviceVoice,setDeviceVoice]=useState(false);
  const [rate,setRate]=useState(1);
  const [code,setCode]=useState('');
  const [busy,setBusy]=useState(false);
  const [downloadProgress,setDownloadProgress]=useState<{done:number;total:number}|null>(null);
  const [pack,setPack]=useState('');
  const [wakeHeld,setWakeHeld]=useState(false);
  const audio=useRef(new AudioEngine()).current;
  const listener=useRef(new VoiceListener()).current;
  const gate=useRef(new TranscriptGate()).current;
  const download=useRef<AbortController|null>(null);
  const stateRef=useRef(mission);stateRef.current=mission;
  const catalogRef=useRef(catalog);catalogRef.current=catalog;
  const commandRef=useRef<(action:Action,voice?:boolean)=>void>(()=>{});
  const platform=platformFor(catalog,mission);
  const segment=segmentFor(catalog,mission);
  const normals=platform.segments.filter(s=>!s.emergency);
  const activeItem=segment?.items[mission.index];
  const currentNormalIndex=normals.findIndex(s=>s.id===mission.segmentId);
  const emergency=Boolean(mission.emergency);
  const listening=listenStatus==='listening';
  const normalDone=normals.reduce((sum,s)=>sum+(mission.progress[s.id]||0),0);
  const normalTotal=normals.reduce((sum,s)=>sum+s.items.length,0);
  const nextSegment=normals[currentNormalIndex+1];

  audio.configure(catalog,config);audio.onStatus=setAudioStatus;audio.onNotice=setNotice;audio.rate=rate;audio.useDeviceVoice=deviceVoice;
  audio.onUnlockRequired=()=>{setSettings(true);setConfig(current=>current?{...current,authenticated:false}:current);};
  listener.onStatus=status=>{audio.setMicrophoneActive(status==='connecting'||status==='listening');setListenStatus(status);};listener.onError=setNotice;
  const sayState=(state:MissionState)=>{
    const c=catalogRef.current;const seg=segmentFor(c,state);
    if(state.emergency==='select'){void audio.play('emergency-prompt',true);return;}
    if(state.emergency&&!seg){void audio.play(`missing-${state.platformId}-${state.emergency}`,true);return;}
    if(state.status==='complete'){void audio.play(state.emergency?'emergency-complete':'segment-complete');return;}
    const item=seg?.items[state.index];if(item)void audio.play(item.id,Boolean(state.emergency));
  };
  const apply=(action:Action,voice=false)=>{
    const before=stateRef.current;
    const after=transition(catalogRef.current,before,action);
    if(after===before)return;
    audio.stop();
    if(action.type==='EMERGENCY'){
      download.current?.abort();setSettings(false);setHelp(false);setSegmentsOpen(false);
      navigator.vibrate?.([120,60,120]);
    }
    stateRef.current=after;setMission(after);
    if(['EMERGENCY','BRANCH','CHECK','START','BACK'].includes(action.type))sayState(after);
    if(action.type==='EXIT_EMERGENCY')setNotice('Normal checklist restored and paused. Resume when ready.');
    if(action.type==='SEGMENT'){
      setSegmentsOpen(false);
      if(voice){const started=transition(catalogRef.current,after,{type:'START'});stateRef.current=started;setMission(started);sayState(started);}
    }
  };
  commandRef.current=apply;
  listener.onTranscript=(text,final)=>{
    setHeard(text);
    const normalized=normalizeSpeech(text);
    // Ignore recognizable playback echo, while always allowing the isolated interrupt.
    if(normalized.split(' ').length>=3 && audio.spokenText && normalizeSpeech(audio.spokenText).includes(normalized))return;
    const state=stateRef.current;
    const command=gate.accept(text,final,platformFor(catalogRef.current,state),Boolean(state.emergency),`${state.platformId}:${state.segmentId}:${state.index}:${state.status}`);
    if(command?.type==='REPEAT')sayState(state);
    else if(command)commandRef.current(command,true);
  };
  const unlockAudio=()=>{void audio.unlock().catch(()=>setNotice('Tap Read item to enable audio.'));};
  const act=(action:Action)=>{unlockAudio();apply(action);};
  const repeat=()=>{unlockAudio();sayState(stateRef.current);};
  const toggleMic=()=>{
    if(['connecting','listening'].includes(listener.status)){listener.stop();gate.reset();return;}
    unlockAudio();gate.reset();setHeard('');
    if(provider==='elevenlabs'&&!config?.authenticated){setSettings(true);setNotice('Unlock voice in settings first.');return;}
    if(provider==='elevenlabs'&&!config?.voiceConfigured){setSettings(true);setNotice('Connect ElevenLabs on the server, or select device recognition to try voice commands.');return;}
    void listener.start(provider);
    if(mission.status==='ready'||mission.status==='paused')apply({type:'START'});
    void audio.preloadEmergencies(platform);
  };
  async function refreshConfig(){
    try{const r=await fetch('/api/config',{signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error();const data=await r.json();setConfig(data);storage.set('onpoint-config',JSON.stringify({...data,authenticated:false}));return data as Config;}catch{return null;}
  }
  useEffect(()=>{
    void refreshConfig();
    const update=()=>setOnline(navigator.onLine);
    window.addEventListener('online',update);window.addEventListener('offline',update);
    const visibility=()=>{
      if(document.hidden){audio.stop();listener.stop();gate.reset();commandRef.current({type:'PAUSE'});setNotice('Voice paused while the app was in the background. Tap the microphone when you return.');}
    };
    document.addEventListener('visibilitychange',visibility);
    return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);document.removeEventListener('visibilitychange',visibility);audio.stop();listener.stop();download.current?.abort();};
  },[]);
  useEffect(()=>{if(!storage.set('onpoint-mission',JSON.stringify(mission)))setNotice('Device storage is unavailable. Progress will last only while this page stays open.');},[mission]);
  useEffect(()=>{
    let cancelled=false;let sentinel:WakeLockSentinel|undefined;
    if((mission.status==='active'||listening)&&'wakeLock' in navigator){
      void navigator.wakeLock.request('screen').then(lock=>{if(cancelled){void lock.release();return;}sentinel=lock;setWakeHeld(true);lock.addEventListener('release',()=>setWakeHeld(false));}).catch(()=>setWakeHeld(false));
    }
    return()=>{cancelled=true;void sentinel?.release();setWakeHeld(false);};
  },[mission.status,listening]);
  useEffect(()=>{setPack(storage.get(`onpoint-pack-${platform.id}-${catalog.revision}-${config?.audioVersion}`)||'');},[platform.id,catalog.revision,config?.audioVersion]);
  async function login(event:React.FormEvent){
    event.preventDefault();setBusy(true);
    try{const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json','X-OnPoint-Client':'1'},body:JSON.stringify({code})});const data=await r.json();if(!r.ok)throw new Error(data.error);setCode('');await refreshConfig();setNotice('Voice unlocked on this device.');}catch(error){setNotice(error instanceof Error?error.message:'Could not unlock voice.');}finally{setBusy(false);}
  }
  async function prepareAudio(){
    download.current?.abort();const controller=new AbortController();download.current=controller;
    setDownloadProgress({done:0,total:platform.segments.reduce((n,s)=>n+s.items.length,0)+4+platform.missingEmergencies.length});
    try{await navigator.storage?.persist?.();await audio.prepare(platform,(done,total)=>setDownloadProgress({done,total}),controller.signal);const now=new Date().toISOString();setPack(now);storage.set(`onpoint-pack-${platform.id}-${catalog.revision}-${config?.audioVersion}`,now);setNotice('Aircraft audio pack saved. Offline listening uses touch controls; voice recognition still needs a connection.');}
    catch(error){setNotice(controller.signal.aborted?'Download paused. Saved audio is kept; download again to finish.':error instanceof Error?error.message:'Audio download failed.');}
    finally{setDownloadProgress(null);download.current=null;}
  }
  async function sync(){
    if(!window.confirm('Refresh checklist templates? If their wording or order changed, saved progress will reset.'))return;
    audio.stop();listener.stop();apply({type:'PAUSE'});setBusy(true);
    try{const r=await fetch('/api/catalog/refresh',{method:'POST',headers:{'X-OnPoint-Client':'1'},signal:AbortSignal.timeout(30000)});const next=await r.json();if(!r.ok)throw new Error(next.error);setCatalog(next);storage.set('onpoint-catalog',JSON.stringify(next));if(next.revision!==catalog.revision){const fresh=initialState(next);stateRef.current=fresh;setMission(fresh);}setNotice('Trello templates refreshed.');}catch(error){setNotice(error instanceof Error?error.message:'Refresh failed.');}finally{setBusy(false);}
  }
  const exportLog=()=>{
    const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),aircraft:platform.name,source:platform.cardUrl,...mission},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`onpoint-mission-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <div className={`app ${emergency?'is-emergency':''}`}>
    <header className="topbar">
      <a className="brand" href="/" aria-label="OnPoint Sky home"><span className="brand-icon"><Radio size={22}/></span><span>ONPOINT <b>SKY</b><small>MISSION CHECKLIST</small></span></a>
      <div className="header-status"><span className={`status-dot ${listening?'live':''}`}/>{listening?'VOICE CONNECTED':'FLIGHT COMPANION'}</div>
      <div className="top-actions"><button className="icon-button" aria-label="Help and iPhone installation" aria-expanded={help} onClick={()=>{setHelp(!help);setSettings(false);}}><CircleHelp size={20}/></button><button className="icon-button" aria-label="Voice settings" aria-expanded={settings} onClick={()=>{setSettings(!settings);setHelp(false);}}><Settings2 size={20}/></button><button className="emergency-button" onClick={()=>act({type:'EMERGENCY'})}><ShieldAlert size={18}/><span>Emergency</span></button></div>
    </header>
    <main className="workspace">
      <div className="page-heading"><div><p className="eyebrow">ONPOINT SKY SOLUTIONS / FLIGHT OPS</p><h1>{emergency?'Emergency procedure':'Mission checklist'}<span className="heading-dot">.</span></h1><p className="subtitle">{emergency?'Normal checklist paused. Select the situation.':'One item at a time. Your focus stays on the flight.'}</p></div><div className="connection-status">{online?<Wifi size={15}/>:<WifiOff size={15}/>}<span>{online?'Online':'Offline · touch controls'}</span></div></div>
      {notice&&<div className="notice" role="status"><span>{notice}</span><button aria-label="Dismiss status message" onClick={()=>setNotice('')}><X size={16}/></button></div>}
      {help&&<section className="settings-panel" aria-label="Help"><div className="panel-title"><h2>Your voice. Your checklist.</h2><button className="icon-button" aria-label="Close help" onClick={()=>setHelp(false)}><X/></button></div><div className="help-grid"><div><h3>On your iPhone</h3><p>Open the HTTPS app address in Safari. Tap Share → Add to Home Screen → Add. Open it and tap Enable voice, then allow microphone access.</p><p>Keep the app open and the screen unlocked. A headset helps separate your voice from the checklist audio.</p></div><div><h3>Voice commands</h3><p><b>Check</b> completes one item. <b>Repeat</b> reads it again. <b>Back</b> reopens the previous item. <b>Pause</b> stops reading; the microphone keeps listening. <b>Pre-departure</b> selects that segment.</p><p><b>Emergency</b> interrupts immediately when recognized. Choose <b>Lost link, GPS, VLOS,</b> or <b>Uncommanded input</b>. Say <b>Resume checklist</b> to leave the procedure.</p></div><div><h3>Before heading out</h3><p>Download your aircraft’s audio in settings. Saved audio and checklists work offline with touch controls. Speech recognition requires connectivity and can be affected by noise or device interruptions.</p><p>This app reads your Trello procedures and records your acknowledgements. It does not control or monitor the aircraft.</p></div></div></section>}
      {settings&&<section className="settings-panel" aria-label="Voice settings panel"><div className="panel-title"><h2>Voice & field setup</h2><button className="icon-button" aria-label="Close settings" onClick={()=>setSettings(false)}><X/></button></div><div className="settings-grid"><div><p className="eyebrow">ELEVENLABS CONNECTION</p><h3>{config?.voiceConfigured?(config.authRequired&&!config.authenticated?'Unlock voice on this device':'Voice ready'):'Connection needed'}</h3><p className="muted">Voice: <code>{config?.voiceId||'TWutjvRaJqAX89preB4e'}</code></p>{!config?.voiceConfigured&&<p>Your ElevenLabs connection must be configured on the app server. Device voice is available for a preview.</p>}{config?.authRequired&&!config.authenticated&&<form onSubmit={login}><label htmlFor="code">App access code</label><div className="input-button"><input id="code" type="password" value={code} onChange={e=>setCode(e.target.value)} autoComplete="current-password" required/><button type="submit" disabled={busy}>Unlock</button></div></form>}{config?.authenticated&&config.authRequired&&<button className="text-button" onClick={()=>{listener.stop();audio.stop();void fetch('/api/session',{method:'DELETE',headers:{'X-OnPoint-Client':'1'}}).then(()=>refreshConfig());}}>Lock voice access</button>}<button className="secondary-button" onClick={()=>{unlockAudio();void audio.play('voice-test');}}><Volume2 size={17}/>Test voice</button><p className="muted">Turn up your media volume while testing. Audio plays through your selected speaker or headset.</p></div><div><label htmlFor="listener">Voice recognition</label><select id="listener" value={provider} onChange={e=>{listener.stop();gate.reset();setProvider(e.target.value as typeof provider);}}><option value="elevenlabs">ElevenLabs · realtime</option><option value="browser">Device recognition · browser dependent</option></select><label htmlFor="speed">Reading speed</label><select id="speed" value={rate} onChange={e=>setRate(Number(e.target.value))}><option value="0.85">0.85× · deliberate</option><option value="1">1× · normal</option><option value="1.15">1.15× · brisk</option></select><label className="checkbox-label"><input type="checkbox" checked={deviceVoice} onChange={e=>{audio.stop();setDeviceVoice(e.target.checked);}}/>Use device voice</label></div><div><p className="eyebrow">TAKE IT INTO THE FIELD</p><h3>{platform.name} audio</h3><p>Download every procedure for this aircraft. Uses ElevenLabs credits for audio not already generated.</p>{downloadProgress?<><progress value={downloadProgress.done} max={downloadProgress.total}/><p>{downloadProgress.done} / {downloadProgress.total} recordings</p><button className="secondary-button" onClick={()=>download.current?.abort()}>Pause download</button></>:<button className="secondary-button" disabled={!config?.voiceConfigured||!config.authenticated||!online||emergency} onClick={()=>void prepareAudio()}><Download size={17}/>{pack?'Verify / finish audio pack':'Download aircraft audio'}</button>}{pack&&<p className="success-text">Pack saved {new Date(pack).toLocaleDateString()}. Your device may clear storage; verify before departure.</p>}</div></div><div className="settings-bottom"><span>App v{version}</span><span>Source snapshot: {new Date(catalog.importedAt).toLocaleString()}</span><button className="text-button" onClick={()=>void sync()} disabled={busy||!config?.trelloConfigured||!config.authenticated||emergency}>Refresh from Trello</button><button className="text-button" onClick={exportLog}>Export progress</button><button className="text-button" disabled={emergency} onClick={()=>{if(window.confirm('Start a new mission? This clears checklist progress for all aircraft on this device.'))act({type:'RESET'});}}>New mission</button><button className="text-button" onClick={()=>{setSettings(false);setHelp(true);}}>Help & install on iPhone</button></div><div className="source-notes"><b>Source notes</b><p>{platform.missingEmergencies.length?`This aircraft’s source is missing: ${platform.missingEmergencies.map(k=>EMERGENCIES.find(e=>e.key===k)?.label).join(', ')}. `:''}{platform.segments.some(s=>s.duplicateCount)?'Repeated checklist entries are preserved from Trello. ':''}Updates to Trello require a refresh or a rebuilt snapshot. Checkmarks are saved on this device; Trello templates are kept intact.</p></div></section>}
      <div className="flight-layout">
        <aside className="mission-sidebar">
          <section className="aircraft-card"><p className="eyebrow">01 / SELECT AIRCRAFT</p><DroneMark/><label htmlFor="aircraft" className="sr-only">Aircraft</label><div className="aircraft-select"><select id="aircraft" value={mission.platformId} disabled={emergency} onChange={e=>act({type:'PLATFORM',id:e.target.value})}>{catalog.platforms.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><ChevronDown size={17}/></div><span className="aircraft-caption">{normals.length} mission segments <span>·</span> {platform.segments.filter(s=>s.emergency).length} emergency procedures</span></section>
          <section className={`segment-nav ${segmentsOpen?'expanded':''}`}><button className="segment-toggle" aria-expanded={segmentsOpen} onClick={()=>setSegmentsOpen(!segmentsOpen)}><span className="eyebrow">02 / CHOOSE SEGMENT</span><ChevronDown size={18}/></button><nav aria-label="Checklist segments"><ol>{normals.map((s,i)=>{const completed=(mission.progress[s.id]||0)===s.items.length;return <li key={s.id}><button disabled={emergency} className={`segment-option ${mission.segmentId===s.id?'selected':''} ${completed?'completed':''}`} aria-current={mission.segmentId===s.id?'step':undefined} onClick={()=>act({type:'SEGMENT',id:s.id})}><span className="step-number">{completed?<Check size={15}/>:pad(i+1)}</span><span><b>{s.label}</b><small>{mission.progress[s.id]||0} / {s.items.length} checked</small></span><ChevronRight size={15}/></button></li>;})}</ol></nav></section>
          <div className="mission-total"><span>Mission progress <b>{normalDone}/{normalTotal}</b></span><progress value={normalDone} max={normalTotal}/><button className="text-button" disabled={emergency} onClick={()=>{if(window.confirm('Start a new mission? This clears checklist progress for all aircraft on this device.'))act({type:'RESET'});}}><RotateCcw size={13}/>New mission</button></div>
        </aside>
        <section className="main-column" aria-label="Active checklist">
          {emergency&&<div className="emergency-banner"><ShieldAlert size={19}/><b>EMERGENCY MODE</b><span>{platform.name}</span></div>}
          {mission.emergency==='select'||(emergency&&!segment)?<div className="emergency-select-panel"><p className="eyebrow">{segment?'':'CHOOSE A PROCEDURE'}</p><h2>{mission.emergency==='select'?'What’s the situation?':'Procedure unavailable'}</h2><p>{mission.emergency==='select'?'Say a category or tap below.':'This procedure is missing from this aircraft’s Trello template. Use your aircraft procedure; the normal checklist remains paused.'}</p><div className="emergency-options">{EMERGENCIES.map(e=><button key={e.key} onClick={()=>act({type:'BRANCH',key:e.key as EmergencyKey})}><span><b>{e.label}</b><small>{platform.missingEmergencies.includes(e.key)?'Not in aircraft source':e.detail}</small></span><ArrowRight size={20}/></button>)}</div><button className="secondary-button" onClick={repeat}><Volume2 size={17}/>Repeat prompt</button></div>:<>
            <div className="active-heading"><div><p className="eyebrow">{emergency?'EMERGENCY PROCEDURE':`SEGMENT ${pad(currentNormalIndex+1)} / ${pad(normals.length)}`}</p><h2>{segment?.label}</h2></div><span className="segment-count">{mission.status==='complete'?'COMPLETE':`${pad(mission.index+1)} / ${pad(segment?.items.length||0)}`}</span></div>
            <div className={`focus-card ${mission.status==='complete'?'finished':''}`}>
              <div className="focus-top"><span className="focus-label">{mission.status==='complete'?<CheckCheck size={16}/>:<span className="tiny-cross">+</span>}{mission.status==='complete'?'SEGMENT COMPLETE':mission.status==='paused'?'CHECKLIST PAUSED':'CURRENT ITEM'}</span><span className={`audio-state ${audioStatus==='speaking'?'speaking':''}`}><span className="wave-bars"><i/><i/><i/><i/><i/></span>{audioStatus==='speaking'?'READING':audioStatus==='loading'?'LOADING AUDIO':mission.status==='active'?'AWAITING CHECK':'READY'}</span></div>
              <div className="focus-content" aria-live="polite" aria-atomic="true"><span className="item-counter">{mission.status==='complete'?<CheckCheck size={55} strokeWidth={1.2}/>:pad(mission.index+1)}</span><h3>{mission.status==='complete'?(emergency?'Procedure complete.':'All checks complete.'):(activeItem?.text||'Select a checklist.')}</h3>{mission.status==='complete'&&<p>{emergency?'Your normal checklist is still paused. Return when you are ready.':nextSegment?`Up next: ${nextSegment.label}.`:'All segments are available from the checklist menu.'}</p>}</div>
              <div className="focus-footer"><span className={`status-dot ${listening?'live':''}`}/>{mission.status==='complete'?'Ready for your next decision':listening?'Say “check” when this item is complete':mission.status==='ready'?'Start when you’re ready':'Complete the item, then tap Check'}<span className="card-reticle">⌖</span></div>
              <div className="card-progress" style={{width:`${segment?mission.index/segment.items.length*100:0}%`}}/>
            </div>
            <div className="checklist-controls"><button className="utility-button" disabled={!mission.index} onClick={()=>act({type:'BACK'})}><ArrowLeft size={19}/><span>Back</span></button><button className="utility-button" onClick={repeat}><Volume2 size={19}/><span>{mission.status==='ready'?'Read item':'Repeat'}</span></button>{mission.status==='active'&&<button className="utility-button desktop-pause" aria-label="Pause checklist" onClick={()=>act({type:'PAUSE'})}><Pause size={18}/></button>}{mission.status==='complete'?<button className="primary-button" onClick={()=>emergency?act({type:'EXIT_EMERGENCY'}):nextSegment?act({type:'SEGMENT',id:nextSegment.id}):setSegmentsOpen(true)}><span>{emergency?'Return to checklist':nextSegment?'Next segment':'Choose segment'}</span><ArrowRight size={20}/></button>:<button className="primary-button" onClick={()=>act({type:mission.status==='active'?'CHECK':'START'})}>{mission.status==='active'?<Check size={24}/>:<Play size={21}/>}<span>{mission.status==='active'?'Check':mission.status==='paused'?'Resume checklist':'Start checklist'}</span>{mission.status==='active'&&<span className="button-hint">NEXT ITEM</span>}</button>}</div>
            <div className="next-item"><span className="eyebrow">UP NEXT</span><p>{segment?.items[mission.index+1]?.text||(emergency?'Complete this procedure.':nextSegment?`${nextSegment.label} segment`:'End of segment')}</p></div>
            {emergency&&segment?.items[mission.index]?.text.toLowerCase().includes('follow rth')&&<button className="secondary-button" onClick={()=>act({type:'BRANCH',key:'rth'})}>Open return-to-home procedure <ArrowRight size={16}/></button>}
            <details className="full-checklist"><summary>View full {segment?.label.toLowerCase()} checklist <ChevronDown size={16}/></summary><ol>{segment?.items.map((item,i)=><li key={item.id} className={i<mission.index?'checked':i===mission.index?'current':''}><span>{i<mission.index?<Check size={15}/>:pad(i+1)}</span><p>{item.text}</p></li>)}</ol></details>
          </>}
          {emergency&&<div className="emergency-return"><button className="text-button" onClick={()=>act({type:'EMERGENCY'})}>Choose another emergency</button><button className="secondary-button" onClick={()=>act({type:'EXIT_EMERGENCY'})}><ArrowLeft size={16}/>Return to normal checklist</button><p>Saved position: {normals.find(s=>s.id===mission.bookmark?.segmentId)?.label}, item {(mission.bookmark?.index||0)+1}</p></div>}
        </section>
        <aside className="voice-sidebar">
          <section className="voice-card"><div className="voice-card-head"><p className="eyebrow">03 / VOICE COPILOT</p><Headphones size={18}/></div><button className={`mic-orb ${listening?'on':''}`} onClick={toggleMic} aria-label={listening?'Turn microphone off':'Enable voice commands'}><span>{listenStatus==='connecting'?<Radio size={31}/>:listenStatus==='error'?<MicOff size={31}/>:<Mic size={31}/>}</span></button><h2>{listening?'Listening for you':listenStatus==='connecting'?'Connecting…':listenStatus==='error'?'Microphone stopped':'Ready to listen'}</h2><p>{listening?'Say “check” to move forward.':listenStatus==='connecting'?'Allow microphone access if prompted.':'Enable voice for hands-free checks.'}</p><button className={`mic-toggle ${listening?'on':''}`} onClick={toggleMic}>{listening?<MicOff size={16}/>:<Mic size={16}/>}<span>{listening?'Turn voice off':listenStatus==='connecting'?'Cancel connection':'Enable voice'}</span></button><div className="heard"><span className="eyebrow">LAST HEARD</span><p aria-live="polite">{heard?`“${heard}”`:'Your words will appear here.'}</p></div><div className="voice-mode"><span className={`status-dot ${config?.voiceConfigured&&!deviceVoice?'live':''}`}/>{deviceVoice||!config?.voiceConfigured?'Device voice':'ElevenLabs voice'}<button aria-label="Configure voice" onClick={()=>setSettings(true)}><Settings2 size={14}/></button></div></section>
          <section className="commands-card"><p className="eyebrow">SPEAK NATURALLY</p><dl><div><dt>“Check”</dt><dd>Complete & continue</dd></div><div><dt>“Repeat”</dt><dd>Read this item again</dd></div><div><dt>“Pre-departure”</dt><dd>Choose a segment</dd></div><div className="emergency-command"><dt>“Emergency”</dt><dd>Interrupt & get a procedure</dd></div></dl><p>Keep the app open. Use a headset for clearer voice commands.</p></section>
          <div className="field-status"><span><span className={`status-dot ${wakeHeld?'live':''}`}/>{wakeHeld?'Screen kept awake':'Screen wake lock inactive'}</span><a href={platform.cardUrl} target="_blank" rel="noreferrer">View source in Trello <ArrowRight size={13}/></a></div>
        </aside>
      </div>
      <footer className="page-footer"><span>ONPOINT SKY <b>/</b> READY FOR WHAT’S NEXT.</span><span>Source: Flight Ops · {new Date(catalog.importedAt).toLocaleDateString()} <span className="footer-divider">|</span> Progress saved on this device</span></footer>
    </main>
    <div className="mobile-voice-bar"><button onClick={toggleMic} className={listening?'listening':''} aria-label={listening?'Turn voice off':'Enable voice'}>{listening?<Mic size={20}/>:<MicOff size={20}/>}<span>{listening?'Listening':listenStatus==='connecting'?'Connecting…':'Voice off'}</span><span className={`status-dot ${listening?'live':''}`}/></button>{mission.status==='active'&&segment&&<button className="mobile-pause" aria-label="Pause checklist reading" onClick={()=>act({type:'PAUSE'})}><Pause size={19}/></button>}{segment&&<button className="mobile-check" onClick={()=>mission.status==='complete'?(emergency?act({type:'EXIT_EMERGENCY'}):nextSegment?act({type:'SEGMENT',id:nextSegment.id}):setSegmentsOpen(true)):act({type:mission.status==='active'?'CHECK':'START'})}>{mission.status==='active'?<Check size={21}/>:<Play size={19}/>}<span>{mission.status==='active'?'Check':mission.status==='paused'?'Resume':mission.status==='complete'?(emergency?'Return':'Next segment'):'Start'}</span></button>}</div>
  </div>;
}
