export type EmergencyKey = 'lost-link' | 'gps' | 'vlos' | 'uncommanded' | 'rth' | 'other';
export interface Item { id: string; text: string }
export interface Segment { id: string; title: string; label: string; aliases: string[]; emergency: EmergencyKey | null; items: Item[]; duplicateCount: number }
export interface Platform { id: string; name: string; cardId: string; cardUrl: string; segments: Segment[]; missingEmergencies: string[] }
export interface Catalog { revision: string; importedAt: string; boardUrl: string; platforms: Platform[] }
export type Status = 'ready' | 'active' | 'paused' | 'complete';
export interface MissionState {
  revision: string; platformId: string; segmentId: string; index: number; status: Status;
  emergency: EmergencyKey | 'select' | null;
  bookmark: { segmentId: string; index: number; status: Status } | null;
  progress: Record<string, number>; startedAt: string;
}
export type Action = { type: 'START' | 'CHECK' | 'BACK' | 'PAUSE' | 'EMERGENCY' | 'EXIT_EMERGENCY' | 'RESET' }
  | { type: 'PLATFORM'; id: string } | { type: 'SEGMENT'; id: string } | { type: 'BRANCH'; key: EmergencyKey };
export interface Config { authenticated: boolean; authRequired: boolean; voiceConfigured: boolean; voiceId: string; audioVersion: string; trelloConfigured: boolean }
