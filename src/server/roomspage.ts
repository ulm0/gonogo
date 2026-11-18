/**
 * The list of rooms that the supervisor serves at `/` (docs/rooms-spec.md). One small page with no build step and no secret in it:
 * it takes the Director token from the address (`#token=`), keeps it where the rooms' own pages look for it (same origin, same key),
 * and asks `/api/rooms`. Names reach the page as text, never as markup.
 */
import { createHash } from 'node:crypto';
import { TOKEN_FRAGMENT_KEY, TOKEN_STORAGE_KEY } from '../shared/protocol.js';

const STYLE = `
:root{color-scheme:light dark;--bg:#e4e2dc;--ink:#1b1b1a;--soft:#5d5b55;--edge:#b9b6ad;--well:#f3f1ec;--warn:#a4410f}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1a;--ink:#ecebe6;--soft:#a3a099;--edge:#46453f;--well:#262522;--warn:#e08a52}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px}
h1{font:600 13px/1 ui-monospace,monospace;letter-spacing:.14em;margin:0 0 16px}
ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
li{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;background:var(--well);border:1px solid var(--edge);border-radius:6px;padding:10px 14px}
.name{font-weight:600;flex:1 1 8em}
.meta{color:var(--soft);font-size:13px}
.need{color:var(--warn);font-weight:600}
a.open{color:inherit;border:1px solid var(--edge);border-radius:6px;padding:4px 12px;text-decoration:none;font-weight:600}
a.open:hover,a.open:focus-visible{background:var(--ink);color:var(--bg)}
a.open[aria-disabled=true]{opacity:.45;pointer-events:none}
p{color:var(--soft)}
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
    const li=el('li'),up=r.state==='running';
    li.append(el('span','name',r.name));
    const m=el('span','meta',r.state==='running'?(r.agents===null?'running':r.running+' of '+r.agents+' agents running'):r.state);
    li.append(m);
    if(r.needsYou)li.append(el('span','need',r.needsYou+' need you'));
    if(r.note&&!up)li.append(el('span','meta',r.note));
    const a=el('a','open','OPEN');a.href='/r/'+encodeURIComponent(r.id)+'/';if(!up)a.setAttribute('aria-disabled','true');
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

export const ROOMS_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': `default-src 'none'; script-src ${hash(SCRIPT)}; style-src ${hash(STYLE)}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export const roomsPage = (): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>gonogo rooms</title><style>${STYLE}</style></head><body><main><h1>ROOMS</h1><ul id="rooms"></ul><p id="note" role="status"></p></main><script>${SCRIPT}</script></body></html>`;
