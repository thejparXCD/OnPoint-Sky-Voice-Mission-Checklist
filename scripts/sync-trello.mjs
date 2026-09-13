import { readFile, writeFile } from 'node:fs/promises';
import { syncSource } from '../server/trello.mjs';
import { normalizeSource } from '../shared/catalog.mjs';
const file=new URL('../data/trello-source.json',import.meta.url);
try {
  const source=JSON.parse(await readFile(file,'utf8'));
  const updated=await syncSource(source,process.env);
  const catalog=normalizeSource(updated);
  await writeFile(file,JSON.stringify(updated,null,2)+'\n');
  console.log(`Updated ${catalog.platforms.length} aircraft templates. Review the data diff, then rebuild.`);
} catch {console.error('Trello sync failed. Check TRELLO_API_KEY and TRELLO_TOKEN. The previous snapshot was preserved.');process.exitCode=1;}
