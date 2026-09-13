import { describe, expect, it } from 'vitest';
import raw from '../data/trello-source.json';
import { normalizeSource } from '../shared/catalog.mjs';
import { initialState, parseCommand, platformFor, restoreState, segmentFor, TranscriptGate, transition } from '../src/mission';
import type { Catalog, EmergencyKey } from '../src/types';
const catalog=normalizeSource(raw) as Catalog;
const advance=(s:ReturnType<typeof initialState>,type:'START'|'CHECK'|'EMERGENCY'|'PAUSE'|'BACK'|'EXIT_EMERGENCY')=>transition(catalog,s,{type});
describe('Mission execution',()=>{
  it('requires an active checklist and advances exactly one item',()=>{
    let s=initialState(catalog);expect(advance(s,'CHECK')).toEqual(s);
    s=advance(s,'START');s=advance(s,'CHECK');expect(s.index).toBe(1);expect(s.progress[s.segmentId]).toBe(1);
    s=advance(s,'PAUSE');expect(advance(s,'CHECK')).toEqual(s);
  });
  it('completes the final item without auto-starting another segment',()=>{
    let s=advance(initialState(catalog),'START');const segment=segmentFor(catalog,s)!;
    for(let i=0;i<segment.items.length;i++)s=advance(s,'CHECK');
    expect(s.status).toBe('complete');expect(s.index).toBe(segment.items.length);expect(s.segmentId).toBe(segment.id);expect(advance(s,'CHECK')).toEqual(s);
    s=advance(s,'BACK');expect(s.index).toBe(segment.items.length-1);expect(s.status).toBe('active');
  });
  it('interrupts a paused checklist and preserves the original bookmark across repeated emergencies',()=>{
    let s=advance(advance(advance(initialState(catalog),'START'),'CHECK'),'PAUSE');const normal={...s};
    s=advance(s,'EMERGENCY');expect(s.emergency).toBe('select');expect(s.bookmark?.index).toBe(1);
    s=transition(catalog,s,{type:'BRANCH',key:'lost-link'});s=advance(s,'CHECK');s=advance(s,'EMERGENCY');
    expect(s.bookmark?.segmentId).toBe(normal.segmentId);expect(s.bookmark?.index).toBe(1);
    expect(transition(catalog,s,{type:'PLATFORM',id:'parrot-anafi-usa'})).toEqual(s);
    s=advance(s,'EXIT_EMERGENCY');expect(s.segmentId).toBe(normal.segmentId);expect(s.index).toBe(1);expect(s.status).toBe('paused');
  });
  it.each(['lost-link','gps','vlos','uncommanded'] as EmergencyKey[])('routes %s to the selected aircraft procedure',key=>{
    let s=transition(catalog,initialState(catalog),{type:'PLATFORM',id:'parrot-anafi-usa'});
    s=advance(s,'EMERGENCY');s=transition(catalog,s,{type:'BRANCH',key});
    expect(segmentFor(catalog,s)?.emergency).toBe(key);expect(s.index).toBe(0);expect(s.status).toBe('active');
  });
  it('never substitutes Parrot instructions for missing DJI procedures',()=>{
    let s=advance(initialState(catalog),'EMERGENCY');s=transition(catalog,s,{type:'BRANCH',key:'gps'});
    expect(s.platformId).toBe('dji-air-3s');expect(segmentFor(catalog,s)).toBeUndefined();expect(s.emergency).toBe('gps');expect(advance(s,'CHECK')).toEqual(s);
  });
  it('retains segment progress across aircraft and segment selections',()=>{
    let s=advance(advance(initialState(catalog),'START'),'CHECK');const first=s.segmentId;
    s=transition(catalog,s,{type:'SEGMENT',id:platformFor(catalog,s).segments[1].id});
    s=transition(catalog,s,{type:'SEGMENT',id:first});expect(s.index).toBe(1);
  });
  it('restores safely paused and rejects changed or corrupt snapshots',()=>{
    const s=advance(advance(initialState(catalog),'START'),'CHECK');
    expect(restoreState(catalog,JSON.stringify(s)).status).toBe('paused');
    expect(restoreState(catalog,JSON.stringify({...s,revision:'old'})).index).toBe(0);
    expect(restoreState(catalog,'garbage').status).toBe('ready');
    expect(restoreState(catalog,JSON.stringify({...s,index:-2})).index).toBe(0);
  });
  it('keeps a completed segment complete when returning to its aircraft',()=>{
    let s=advance(initialState(catalog),'START');const count=segmentFor(catalog,s)!.items.length;
    for(let i=0;i<count;i++)s=advance(s,'CHECK');
    s=transition(catalog,s,{type:'PLATFORM',id:'parrot-anafi-usa'});
    s=transition(catalog,s,{type:'PLATFORM',id:'dji-air-3s'});
    expect(s.status).toBe('complete');expect(s.index).toBe(count);
    expect(advance(s,'START')).toEqual(s);
  });
});
describe('Voice command handling',()=>{
  const p=catalog.platforms[1];
  it.each(['check','CHECK!','Checked.'])('recognizes acknowledgement %s',text=>expect(parseCommand(text,p,false)?.type).toBe('CHECK'));
  it.each(['check battery','do not check','checklist','we should check the site'])('ignores non-command speech %s',text=>expect(parseCommand(text,p,false)).toBeNull());
  it('prioritizes emergency over a check in the same phrase',()=>expect(parseCommand('check EMERGENCY',p,false)?.type).toBe('EMERGENCY'));
  it('supports segment names and spoken emergency abbreviations',()=>{
    expect(parseCommand('pre-departure',p,false)).toEqual({type:'SEGMENT',id:p.segments[0].id});
    expect(parseCommand('G P S',p,true)).toEqual({type:'BRANCH',key:'gps'});
    expect(parseCommand('V L O S',p,true)).toEqual({type:'BRANCH',key:'vlos'});
    expect(parseCommand('pre departure',p,true)).toBeNull();
  });
  it('interrupts on an interim transcript once and suppresses its final echo',()=>{
    const gate=new TranscriptGate();expect(gate.accept('emergency',false,p,false)?.type).toBe('EMERGENCY');
    expect(gate.accept('emergency',false,p,true)).toBeNull();expect(gate.accept('emergency check',true,p,true)).toBeNull();
    expect(gate.accept('GPS',true,p,true)).toEqual({type:'BRANCH',key:'gps'});
  });
  it('does not advance on interim check, duplicate final, or a stale utterance',()=>{
    const gate=new TranscriptGate();expect(gate.accept('check',false,p,false,'item1',1000)).toBeNull();
    expect(gate.accept('check',true,p,false,'item2',1200)).toBeNull();
    expect(gate.accept('check',true,p,false,'item2',2000)?.type).toBe('CHECK');
    expect(gate.accept('check',true,p,false,'item3',2100)).toBeNull();
    expect(gate.accept('check',true,p,false,'item3',3100)?.type).toBe('CHECK');
  });
});
describe('Trello source fidelity',()=>{
  it('preserves every template item, its order, and text',()=>{
    raw.platforms.forEach((p,pi)=>[...p.checklists].sort((a,b)=>a.position-b.position).forEach((s,si)=>{
      expect(catalog.platforms[pi].segments[si].items).toEqual([...s.items].sort((a,b)=>a.position-b.position).map(i=>({id:i.id,text:i.text.trim()})));
    }));
  });
  it('surfaces source duplicates and missing emergency branches',()=>{
    expect(catalog.platforms[0].missingEmergencies).toEqual(['gps','vlos','uncommanded']);
    expect(catalog.platforms[1].segments.find(s=>s.emergency==='lost-link')?.duplicateCount).toBe(12);
  });
});
