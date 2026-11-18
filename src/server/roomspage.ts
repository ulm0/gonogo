/**
 * The list of rooms that the supervisor serves at `/` (docs/rooms-spec.md). One small page with no build step and no secret in it:
 * it takes the Director token from the address (`#token=`), keeps it where the rooms' own pages look for it (same origin, same key),
 * and asks `/api/rooms`. Names reach the page as text, never as markup.
 *
 * It wears the app's own primitives (.module, .label, .tile, .btn, .hint) by linking the stylesheet of the built client, which the
 * supervisor serves from `/assets/` (supervisor.ts); the few lines of layout below are all it adds. Without a built client it falls
 * back to plain system styles.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOKEN_FRAGMENT_KEY, TOKEN_STORAGE_KEY } from '../shared/protocol.js';

const STYLE = `
body{margin:0;background:var(--body,#e4e2dc);color:var(--text,#1b1b1a);font:15px/1.4 var(--font-ui,system-ui,sans-serif)}
main{max-width:640px;margin:0 auto;padding:24px 16px;display:grid;gap:12px}
ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.tile{flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:flex-start;gap:4px 12px;cursor:default}
.tile .tile-legend{flex:1 1 8em}
a.btn{text-decoration:none}
.add{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-top:12px}
.add .input{flex:1 1 9em;min-width:0}
.tile .input{flex:1 1 8em;min-width:0}
a.btn[aria-disabled=true]{opacity:.45;pointer-events:none}
`;

const SCRIPT = `
const KEY=${JSON.stringify(TOKEN_STORAGE_KEY)},FRAG=${JSON.stringify(TOKEN_FRAGMENT_KEY)};
const list=document.getElementById('rooms'),note=document.getElementById('note'),form=document.getElementById('add');
let token=null,editing=false;
try{
  const h=new URLSearchParams(location.hash.slice(1));
  if(/^[0-9a-f]{64}$/i.test(h.get(FRAG)||'')){token=h.get(FRAG);try{localStorage.setItem(KEY,token)}catch{}history.replaceState(null,'',location.pathname)}
  else token=localStorage.getItem(KEY);
}catch{}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function key(label,kind,fn){const b=el('button','btn',label);b.type='button';if(kind)b.dataset.kind=kind;b.addEventListener('click',fn);return b}
async function call(method,path,body){
  const res=await fetch(path,{method,headers:Object.assign({Authorization:'Bearer '+token},body?{'Content-Type':'application/json'}:{}),body:body?JSON.stringify(body):undefined,cache:'no-store'});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.error||('error '+res.status));
  return data;
}
function fail(e){note.textContent=e instanceof Error?e.message:String(e)}
function rename(li,r){
  editing=true;
  const input=el('input','input');input.value=r.name;input.maxLength=40;input.setAttribute('aria-label','New name of '+r.name);
  const save=async()=>{try{await call('PATCH','/api/rooms/'+encodeURIComponent(r.id),{name:input.value});editing=false;note.textContent='';load()}catch(e){fail(e)}};
  input.addEventListener('keydown',e=>{if(e.key==='Enter')save();if(e.key==='Escape'){editing=false;load()}});
  li.replaceChildren(input,key('SAVE','primary',save),key('CANCEL','',()=>{editing=false;load()}));
  input.focus();input.select();
}
async function remove(r){
  if(!confirm('Remove the room "'+r.name+'"? gonogo stops it and its agents. Its folder stays on disk (rooms/'+r.id+'); nothing is deleted.'))return;
  try{await call('DELETE','/api/rooms/'+encodeURIComponent(r.id));note.textContent='';load()}catch(e){fail(e)}
}
function show(rooms){
  list.replaceChildren(...rooms.map(r=>{
    const li=el('li','tile'),up=r.state==='running';
    li.dataset.kind=r.needsYou?'needs':up?'working':r.state==='starting'?'starting':'stopped';
    li.append(el('span','tile-legend',r.name));
    li.append(el('span','tile-sub',up?(r.agents===null?'running':r.running+' of '+r.agents+' agents running'):r.state));
    if(r.needsYou)li.append(el('span','hint',r.needsYou+' need you'));
    if(r.note&&!up)li.append(el('span','hint',r.note));
    const a=el('a','btn','OPEN');a.dataset.kind='primary';a.href='/r/'+encodeURIComponent(r.id)+'/';if(!up)a.setAttribute('aria-disabled','true');
    li.append(a);
    if(r.id!=='main'){li.append(key('RENAME','',()=>rename(li,r)));li.append(key('REMOVE','',()=>remove(r)))}
    return li}));
}
async function load(){
  if(editing)return;
  if(!token){note.textContent='Open this page with the address gonogo printed: it ends in #token=...';form.hidden=true;return}
  try{
    const res=await fetch('/api/rooms',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
    if(res.status===401){note.textContent='That token is not this server\\u2019s. Use the address gonogo printed.';form.hidden=true;return}
    show((await res.json()).rooms||[]);
  }catch{note.textContent='Could not reach the server.'}
}
form.addEventListener('submit',async e=>{
  e.preventDefault();
  const id=form.elements.id.value.trim(),name=form.elements.name.value.trim();
  try{await call('POST','/api/rooms',name?{id,name}:{id});form.reset();note.textContent='';load()}catch(err){fail(err)}
});
load();setInterval(load,5000);
`;

const hash = (text: string): string => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** The name of the built client's stylesheet (`assets/index-<hash>.css`), or null when there is no built client. */
export function clientStylesheet(staticDir: string | null): string | null {
  if (staticDir === null || !existsSync(join(staticDir, 'index.html'))) return null;
  const found = /<link[^>]*rel="stylesheet"[^>]*href="\.\/assets\/([\w.-]+\.css)"/.exec(readFileSync(join(staticDir, 'index.html'), 'utf8'));
  return found?.[1] ?? null;
}

export const roomsPageHeaders = (): Record<string, string> => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': `default-src 'none'; script-src ${hash(SCRIPT)}; style-src 'self' ${hash(STYLE)}; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

export const roomsPage = (stylesheet: string | null): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>gonogo rooms</title>${
    stylesheet === null ? '' : `<link rel="stylesheet" href="/assets/${stylesheet}">`
  }<style>${STYLE}</style></head><body><main><section class="module"><h1 class="label">ROOMS</h1><ul id="rooms"></ul><form id="add" class="add"><span class="label">NEW ROOM</span><input class="input" name="id" required maxlength="24" pattern="[a-z][a-z0-9-]{0,23}" placeholder="id: team-a" aria-label="Room id" autocomplete="off"><input class="input" name="name" maxlength="40" placeholder="name (optional)" aria-label="Room name" autocomplete="off"><button class="btn" data-kind="primary" type="submit">ADD</button></form><p id="note" class="hint" role="status"></p></section></main><script>${SCRIPT}</script></body></html>`;
