import type { Config, Context } from '@netlify/functions';
import { createFetchHandler } from '../../server/fetch-adapter.mjs';

let handler: ReturnType<typeof createFetchHandler> | undefined;

export default async (request: Request, context: Context) => {
  if (!handler) {
    const keys = ['APP_ACCESS_CODE', 'SESSION_SECRET', 'APP_ORIGIN', 'N8N_VOICE_BASE_URL', 'N8N_VOICE_SECRET', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_MODEL_ID', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET'];
    const env = Object.fromEntries(keys.map(key => [key, Netlify.env.get(key)]));
    // Runtime checklist edits cannot be shared reliably across function instances.
    // Refresh the bundled Trello snapshot and deploy it for every device instead.
    handler = createFetchHandler({ env: { ...env, NODE_ENV: 'production' } });
  }
  return handler(request, context.ip);
};

export const config: Config = {
  path: '/api/*',
  rateLimit: { windowLimit: 180, windowSize: 60, aggregateBy: ['ip'] },
};
