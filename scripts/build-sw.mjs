import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { relative, join } from 'node:path';
const root = new URL('../dist/',import.meta.url);
const files=await readdir(root,{recursive:true,withFileTypes:true});
const urls=['/',...files.filter(f=>f.isFile()&&f.name!=='sw.js').map(f=>'/'+relative(fileURLToPath(root),join(f.parentPath,f.name)).replaceAll('\\','/'))];
const hash=createHash('sha256').update(await readFile(new URL('index.html',root))).digest('hex').slice(0,12);
await writeFile(new URL('sw.js',root),`const SHELL='onpoint-shell-${hash}';
const FILES=${JSON.stringify(urls)};
self.addEventListener('install',event=>event.waitUntil(caches.open(SHELL).then(cache=>cache.addAll(FILES))));
// Do not skipWaiting: a new version must never replace a checklist mid-mission.
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('onpoint-shell-')&&k!==SHELL).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 event.respondWith(caches.open(SHELL).then(async cache=>{
   const cached=await cache.match(event.request);if(cached)return cached;
   if(event.request.mode==='navigate')return (await cache.match('/'))||fetch(event.request);
   return fetch(event.request);
 }));
});\n`);
console.log(`Service worker: ${urls.length} shell assets, version ${hash}`);
