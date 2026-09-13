import type { Action, Catalog, EmergencyKey, MissionState, Platform, Segment } from './types';
export function initialState(catalog: Catalog): MissionState {
  const p = catalog.platforms[0]; const s = p.segments.find(s => !s.emergency)!;
  return { revision: catalog.revision, platformId: p.id, segmentId: s.id, index: 0, status: 'ready', emergency: null, bookmark: null, progress: {}, startedAt: new Date().toISOString() };
}
export const platformFor = (c: Catalog, s: MissionState): Platform => c.platforms.find(p => p.id === s.platformId)!;
export const segmentFor = (c: Catalog, s: MissionState): Segment | undefined => platformFor(c,s).segments.find(x => x.id === s.segmentId);
export function transition(c: Catalog, s: MissionState, a: Action): MissionState {
  const p = platformFor(c,s); const segment = segmentFor(c,s);
  switch (a.type) {
    case 'RESET': return s.emergency ? s : { ...initialState(c), platformId: p.id, segmentId: p.segments.find(x => !x.emergency)!.id };
    case 'PLATFORM': {
      if (s.emergency) return s;
      const next = c.platforms.find(p => p.id === a.id); if (!next) return s;
      const seg = next.segments.find(x => !x.emergency)!;
      const index = Math.min(s.progress[seg.id] ?? 0, seg.items.length);
      return { ...s, platformId: next.id, segmentId: seg.id, index, status: index === seg.items.length ? 'complete' : 'ready' };
    }
    case 'SEGMENT': {
      if (s.emergency) return s;
      const seg = p.segments.find(x => x.id === a.id && !x.emergency); if (!seg) return s;
      const index = Math.min(s.progress[seg.id] ?? 0, seg.items.length);
      return { ...s, segmentId: seg.id, index, status: index === seg.items.length ? 'complete' : 'ready' };
    }
    case 'START': return !segment || s.emergency === 'select' || s.index >= segment.items.length ? s : { ...s, status: 'active' };
    case 'PAUSE': return s.status === 'active' ? { ...s, status: 'paused' } : s;
    case 'CHECK': {
      if (s.status !== 'active' || s.emergency === 'select' || !segment || s.index >= segment.items.length) return s;
      const index = s.index + 1;
      return { ...s, index, status: index === segment.items.length ? 'complete' : 'active', progress: { ...s.progress, [segment.id]: index } };
    }
    case 'BACK': {
      if (s.emergency === 'select' || !segment || !s.index) return s;
      const index = s.index - 1;
      return { ...s, index, status: s.status === 'paused' ? 'paused' : 'active', progress: { ...s.progress, [segment.id]: index } };
    }
    case 'EMERGENCY': return { ...s, emergency: 'select', segmentId: '', index: 0, status: 'active', bookmark: s.bookmark ?? { segmentId: s.segmentId, index: s.index, status: s.status } };
    case 'BRANCH': {
      if (!s.emergency) return s;
      const seg = p.segments.find(x => x.emergency === a.key);
      return { ...s, emergency: a.key, segmentId: seg?.id ?? '', index: 0, status: 'active', progress: seg ? { ...s.progress, [seg.id]: 0 } : s.progress };
    }
    case 'EXIT_EMERGENCY': return !s.bookmark ? s : { ...s, ...s.bookmark, status: s.bookmark.status === 'complete' ? 'complete' : 'paused', emergency: null, bookmark: null };
  }
}
export function restoreState(catalog: Catalog, raw: string | null): MissionState {
  try {
    const s = JSON.parse(raw ?? 'null') as MissionState;
    if (!s || s.revision !== catalog.revision || !catalog.platforms.some(p => p.id === s.platformId)) return initialState(catalog);
    if (!['ready','active','paused','complete'].includes(s.status) || !Number.isInteger(s.index) || s.index < 0 || !s.progress || typeof s.progress !== 'object') return initialState(catalog);
    const p = platformFor(catalog,s);
    const knownEmergency = ['select','lost-link','gps','vlos','uncommanded','rth','other'];
    if (s.emergency !== null && !knownEmergency.includes(s.emergency)) return initialState(catalog);
    const segment = segmentFor(catalog,s);
    if ((!s.emergency && (!segment || segment.emergency)) || (segment && s.index > segment.items.length)) return initialState(catalog);
    if (s.emergency) {
      const bookmarkSegment = p.segments.find(seg => seg.id === s.bookmark?.segmentId && !seg.emergency);
      if (!s.bookmark || !bookmarkSegment || !Number.isInteger(s.bookmark.index) || s.bookmark.index < 0 || s.bookmark.index > bookmarkSegment.items.length) return initialState(catalog);
      if (segment && segment.emergency !== s.emergency) return initialState(catalog);
      if (!segment && s.index !== 0) return initialState(catalog);
    }
    const progress: Record<string,number> = {};
    for (const p of catalog.platforms) for (const seg of p.segments) {
      const value = s.progress[seg.id];
      if (Number.isInteger(value) && value >= 0 && value <= seg.items.length) progress[seg.id] = value;
    }
    return { ...s, progress, status: s.status === 'active' ? 'paused' : s.status };
  } catch { return initialState(catalog); }
}
export function normalizeSpeech(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
}
export function parseCommand(text: string, platform: Platform, emergency: boolean): Action | {type:'REPEAT'} | null {
  const t = normalizeSpeech(text);
  if (/\bemergency\b/.test(t)) return { type: 'EMERGENCY' };
  if (emergency) {
    if (/^(resume|return to|exit to) (normal )?checklist$/.test(t) || t === 'exit emergency mode') return { type: 'EXIT_EMERGENCY' };
    const branches: [EmergencyKey,RegExp][] = [
      ['lost-link', /^(lost link|loss of link|weak link|c2|c 2|lost command link)$/],
      ['gps', /^(gps|g p s|gps issue|lost gps|loss of gps)$/],
      ['vlos', /^(vlos|v los|v loss|v l o s|lost visual|loss of vlos|visual line of sight)$/],
      ['uncommanded', /^(uncommanded( control)? input|uncommanded|un commanded input)$/],
      ['rth', /^(rth|r t h|return to home)$/],
    ];
    for (const [key,re] of branches) if (re.test(t)) return {type:'BRANCH',key};
  }
  if (/^(check|checked|check check)$/.test(t)) return {type:'CHECK'};
  if (/^(repeat|say again|repeat item)$/.test(t)) return {type:'REPEAT'};
  if (/^(back|previous|previous item)$/.test(t)) return {type:'BACK'};
  if (/^(pause|hold|pause checklist)$/.test(t)) return {type:'PAUSE'};
  if (/^(start|resume|continue|start checklist)$/.test(t)) return {type:'START'};
  if (!emergency) {
    const target = t.replace(/^(select|start|switch to|go to) /,'');
    const segment = platform.segments.find(s => !s.emergency && [s.label,...s.aliases,s.title].some(a => normalizeSpeech(a) === target));
    if (segment) return {type:'SEGMENT',id:segment.id};
  }
  return null;
}
// An interim emergency interrupts once. Its eventual final transcript must not
// restart the prompt or advance any procedure, even if it also contains “check”.
export class TranscriptGate {
  private interrupted = false;
  private partialContext: string | null = null;
  private lastCheck = -Infinity;
  reset() { this.interrupted = false; this.partialContext = null; this.lastCheck = -Infinity; }
  accept(text: string, final: boolean, p: Platform, emergency: boolean, context = '', now = Date.now()) {
    if (/\bemergency\b/i.test(text) && !this.interrupted) {
      this.interrupted = !final; this.partialContext = null;
      return {type:'EMERGENCY'} as Action;
    }
    if (this.interrupted) { if (final) { this.interrupted = false; this.partialContext = null; } return null; }
    if (!final) { this.partialContext ??= context; return null; }
    const stale = this.partialContext !== null && this.partialContext !== context;
    this.partialContext = null;
    if (stale) return null;
    const command = parseCommand(text,p,emergency);
    if (command?.type === 'CHECK') { if (now-this.lastCheck < 800) return null; this.lastCheck = now; }
    return command;
  }
}
