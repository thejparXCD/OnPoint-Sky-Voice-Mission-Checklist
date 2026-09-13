export async function syncSource(source,env,fetchImpl=fetch) {
  if (!env.TRELLO_API_KEY || !env.TRELLO_TOKEN) throw new Error('Trello credentials are not configured.');
  const auth=new URLSearchParams({key:env.TRELLO_API_KEY,token:env.TRELLO_TOKEN});
  const platforms=[];
  for (const p of source.platforms) {
    const response=await fetchImpl(`https://api.trello.com/1/cards/${p.cardId}/checklists?${auth}`,{signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error('Trello request failed.');
    const lists=await response.json();
    if (!Array.isArray(lists)||!lists.length) throw new Error('Trello returned no checklists.');
    platforms.push({...p,checklists:lists.map(c=>({id:c.id,name:c.name,position:c.pos,items:c.checkItems.map(it=>({id:it.id,text:it.name,position:it.pos}))}))});
  }
  return {...source,importedAt:new Date().toISOString(),platforms};
}
