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
a.btn[aria-disabled=true]{opacity:.45;pointer-events:none}
`;

const SCRIPT = `
const KEY=${JSON.stringify(TOKEN_STORAGE_KEY)},FRAG=${JSON.stringify(TOKEN_FRAGMENT_KEY)};
const list=document.getElementById('rooms'),note=document.getElementById('note');
let token=null;
try{
  const h=new URLSearchParams(location.hash.slice(1));
  if(/^[0-9a-f]{64}$/i.test(h.get(FRAG)||'')){token=h.get(FRAG);try{localStorage.setItem(KEY,token)}catch{}history.replaceState(null,'',location.pathname)}
  else token=localStorage.getItem(KEY);
}catch{}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function show(rooms){
  list.replaceChildren(...rooms.map(r=>{
    const li=el('li','tile'),up=r.state==='running';
    li.dataset.kind=r.needsYou?'needs':up?'working':r.state==='starting'?'starting':'stopped';
    li.append(el('span','tile-legend',r.name));
    li.append(el('span','tile-sub',up?(r.agents===null?'running':r.running+' of '+r.agents+' agents running'):r.state));
    if(r.needsYou)li.append(el('span','hint',r.needsYou+' need you'));
    if(r.note&&!up)li.append(el('span','hint',r.note));
    const a=el('a','btn','OPEN');a.dataset.kind='primary';a.href='/r/'+encodeURIComponent(r.id)+'/';if(!up)a.setAttribute('aria-disabled','true');
    li.append(a);return li}));
}
async function load(){
  if(!token){note.textContent='Open this page with the address gonogo printed: it ends in #token=...';return}
  try{
    const res=await fetch('/api/rooms',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
    if(res.status===401){note.textContent='That token is not this server\\u2019s. Use the address gonogo printed.';return}
    note.textContent='';show((await res.json()).rooms||[]);
  }catch{note.textContent='Could not reach the server.'}
}
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
  }<style>${STYLE}</style></head><body><main><section class="module"><h1 class="label">ROOMS</h1><ul id="rooms"></ul><p id="note" class="hint" role="status"></p></section></main><script>${SCRIPT}</script></body></html>`;
