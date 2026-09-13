export const EMERGENCIES = [
  { key: 'lost-link', label: 'Lost link', detail: 'Command & control link' },
  { key: 'gps', label: 'GPS', detail: 'Lost or unreliable position' },
  { key: 'vlos', label: 'VLOS', detail: 'Loss of visual contact' },
  { key: 'uncommanded', label: 'Uncommanded input', detail: 'Unexpected aircraft response' },
];
export const PROMPTS = {
  'emergency-prompt': 'Lost link, GPS, VLOS, or uncommanded input?',
  'segment-complete': 'Segment complete. Select your next segment when ready.',
  'emergency-complete': 'Procedure complete. Your normal checklist remains paused.',
  'voice-test': 'OnPoint Sky. Voice check complete. Ready when you are.',
};
const labels = ['Pre-departure', 'On-site setup', 'Crew & mission', 'Go / No-go', 'In-flight', 'Landing & shutdown', 'Post-flight'];
const aliases = [
  ['pre departure', 'predeparture', 'office'], ['on site', 'onsite', 'setup', 'physical inspection'],
  ['crew', 'mission briefing', 'crew and mission'], ['go no go', 'launch', 'final go no go'],
  ['in flight', 'inflight', 'monitoring'], ['landing', 'shutdown', 'landing and shutdown'],
  ['post flight', 'postflight', 'maintenance'],
];
const normalKinds = [/pre.?departure|office/i, /on.?site|physical inspection/i, /crew|mission.*automation/i, /go.*no.?go|launch/i, /in.?flight/i, /landing.*shutdown/i, /post.?flight/i];
export function normalizeSource(source) {
  if (!source || !Array.isArray(source.platforms) || !source.platforms.length) throw new Error('No aircraft templates found.');
  const platforms = source.platforms.map(p => {
    const segments = [...p.checklists].sort((a,b) => a.position - b.position).map(c => {
      const isEmergency = /emergency/i.test(c.name);
      let emergency = null;
      if (isEmergency) {
        if (/lost link|c2 link/i.test(c.name) || (p.id === 'dji-air-3s' && c.id === '69ef9ddbb8d524b7fa6131a3' && c.name.trim() === 'Emergency Procedures')) emergency = 'lost-link';
        else if (/gps/i.test(c.name)) emergency = 'gps';
        else if (/vlos/i.test(c.name)) emergency = 'vlos';
        else if (/uncommanded/i.test(c.name)) emergency = 'uncommanded';
        else if (/rth/i.test(c.name)) emergency = 'rth';
        else emergency = 'other';
      }
      const i = normalKinds.findIndex(re => re.test(c.name));
      const items = [...c.items].sort((a,b) => a.position - b.position).map(it => ({ id: it.id, text: it.text.trim() }));
      if (!items.length || items.some(it => !it.id || !it.text)) throw new Error(`Empty checklist: ${c.name}`);
      const seen = new Set();
      const duplicateCount = items.reduce((n,it) => { const v = it.text.toLowerCase(); const duplicate = seen.has(v); seen.add(v); return n + Number(duplicate); }, 0);
      return { id: c.id, title: c.name, label: isEmergency ? (EMERGENCIES.find(e => e.key === emergency)?.label ?? (emergency === 'rth' ? 'Return to home' : c.name)) : (labels[i] ?? c.name), aliases: isEmergency ? [] : (aliases[i] ?? []), emergency, items, duplicateCount };
    });
    return { id: p.id, name: p.name, cardId: p.cardId, cardUrl: p.cardUrl, segments,
      missingEmergencies: EMERGENCIES.filter(e => !segments.some(s => s.emergency === e.key)).map(e => e.key) };
  });
  // Stable content revision, independent of sync time; invalidates saved progress on source changes.
  let hash = 2166136261;
  for (const ch of JSON.stringify(platforms)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return { revision: (hash >>> 0).toString(16), importedAt: source.importedAt, boardUrl: source.boardUrl, platforms };
}
export function speechIndex(catalog) {
  const entries = { ...PROMPTS };
  for (const p of catalog.platforms) {
    for (const s of p.segments) for (const item of s.items) entries[item.id] = item.text;
    for (const e of EMERGENCIES) entries[`missing-${p.id}-${e.key}`] = `${e.label} procedure is not available in the ${p.name} source checklist. Use your aircraft procedure. Your normal checklist remains paused.`;
  }
  return entries;
}
