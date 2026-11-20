/**
 * The list of rooms that the supervisor serves at `/` (docs/rooms-spec.md). One small page with no build step and no secret in it:
 * it takes the Director token from the address (`#token=`), keeps it where the rooms' own pages look for it (same origin, same key),
 * and asks `/api/rooms`. Names reach the page as text, never as markup.
 *
 * It is dressed like the app: the top bar with the logo, a card for each room made of the Room view's own primitives (.tile, .led,
 * .tile-lcd, .btn, .chip, .flood), the version corner, and the livery of the last visit (the room pages keep it in this origin's
 * localStorage). It gets them by linking the stylesheet of the built client, which the supervisor serves from `/assets/`
 * (supervisor.ts); the few lines of layout below are all it adds. Without a built client it falls back to plain system styles.
 * Two scripts, each allowed by its own hash: the livery runs in the head (no flash of the wrong look), the page at the end.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIVERY_NAMES } from '../shared/livery.js';
import { TOKEN_FRAGMENT_KEY, TOKEN_STORAGE_KEY } from '../shared/protocol.js';

/** Where the supervisor serves this page. The page itself uses no path of its own for it (it keeps the address it is opened at), so moving it is this one line. */
export const ROOMS_PATH = '/rooms';

const STYLE = `
body{margin:0;background:var(--body,#e4e2dc);color:var(--text,#1b1b1a);font:15px/1.4 var(--font-ui,system-ui,sans-serif)}
.rl-main{max-width:1120px;margin:0 auto;padding:16px 24px 48px;display:grid;gap:14px}
.rl-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
.rl-head h2{margin:0 8px 0 0}
.rl-cards{list-style:none;margin:0;padding:0;display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))}
.rl-card{gap:10px;padding:12px;cursor:default}
.rl-card.rl-open{cursor:pointer}
.rl-card .tile-head{min-height:28px}
.rl-name{flex:1 1 auto;min-width:0;margin:0;overflow-wrap:anywhere}
.rl-card .tile-state{margin-left:auto;white-space:nowrap}
.rl-card .tile-lcd{min-height:0;padding:8px 10px;font-size:12px}
.rl-card .tile-foot{font-family:var(--font-mono);font-size:11.5px;color:var(--muted);overflow:hidden}
.rl-card .tile-foot span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.rl-keys{display:flex;flex-wrap:wrap;gap:8px}
.rl-keys .btn{flex:1 1 auto}
.rl-keys .btn[data-kind=primary]{flex-grow:2}
.rl-keys .input{flex:1 1 9em;min-width:0}
.rl-new{align-items:flex-start;justify-content:center;min-height:120px}
.rl-form,.rl-gate{display:grid;gap:12px;padding:14px;max-width:560px}
.rl-form[hidden],.rl-gate[hidden],.rl-error[hidden]{display:none}
.rl-fields{display:flex;flex-wrap:wrap;gap:10px}
.rl-fields label{display:grid;gap:4px;flex:1 1 12em;min-width:0}
.rl-confirm{display:grid;gap:8px;padding:10px 12px}
.rl-confirm p{margin:0}
.rl-error{padding:10px 12px;margin:0}
@media (max-width:699px){.rl-main{padding:10px 12px 40px}.rl-keys .btn[data-kind=primary]{flex-basis:100%}}
`;

/**
 * Puts the livery of the last visit on the page before it is drawn. The room pages write it after checking it; the rule here is the
 * app's own (look.ts storedEntry, checkLivery): all or nothing. Every token name of the livery must be there, nothing else, and every
 * value a colour of the forms of isColour (shared/livery.ts: hex, rgb, hsl, oklch, at most 64 characters, in range); one fault and the
 * default look stays. test/roomspage.test.ts keeps ok() equal to isColour over a list of values. The scheme (dark or light, for the logo
 * and the browser's own widgets) is worked out here for hex and rgb() bodies only: shortcut: another form of --body reads as light, so
 * the logo may not turn on a dark livery written in hsl() or oklch(); upgrade by sharing the colour maths with the page.
 */
const LIVERY = `
try{
  const NAMES=${JSON.stringify(LIVERY_NAMES)};
  const N='[+-]?(?:\\\\d+\\\\.?\\\\d*|\\\\.\\\\d+)',NR=new RegExp('^'+N+'$'),PR=new RegExp('^'+N+'%$'),AR=new RegExp('^'+N+'(?:deg)?$');
  const ok=v=>{
    if(typeof v!=='string'||v.length>64)return false;
    const t=v.trim();
    if(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(t))return true;
    const f=/^(rgb|hsl|oklch)\\(\\s*([^()]*?)\\s*\\)$/i.exec(t);
    if(!f)return false;
    const b=f[2],l=b.includes(',')?b.split(/\\s*,\\s*/):b.split(/\\s+/);
    if(l.length!==3||l.some(q=>q===''))return false;
    const x=l[0],y=l[1],z=l[2];
    switch(f[1].toLowerCase()){
      case 'rgb':{const pc=PR.test(x);return l.every(q=>pc?PR.test(q):NR.test(q))&&l.every(q=>{const n=parseFloat(q)/(pc?100:255);return n>=0&&n<=1})}
      case 'hsl':{if(!AR.test(x)||!PR.test(y)||!PR.test(z))return false;const s=parseFloat(y)/100,k=parseFloat(z)/100;return s>=0&&s<=1&&k>=0&&k<=1}
      default:{const L=PR.test(x)?parseFloat(x)/100:NR.test(x)?parseFloat(x):NaN;return L>=0&&L<=1&&NR.test(y)&&parseFloat(y)>=0&&AR.test(z)}
    }
  };
  const k=JSON.parse(localStorage.getItem('gonogo.livery')||'null');
  if(k&&typeof k.slug==='string'&&/^[a-z0-9][a-z0-9-]{0,39}$/.test(k.slug)&&k.slug!=='instrument'&&k.tokens&&typeof k.tokens==='object'&&!Array.isArray(k.tokens)
    &&Object.keys(k.tokens).every(n=>NAMES.includes(n))&&NAMES.every(n=>ok(k.tokens[n]))){
    const root=document.documentElement,css=root.style;
    for(const n of NAMES)css.setProperty(n,k.tokens[n].trim());
    const lin=c=>c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4);
    const body=String(k.tokens['--body']).trim();
    let rgb=null,m=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(body);
    if(m)rgb=[1,2,3].map(i=>parseInt(m[i],16)/255);
    else if((m=/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(body)))rgb=[1,2,3].map(i=>parseInt(m[i]+m[i],16)/255);
    else if((m=/^rgb\(\s*([^()]*?)\s*\)$/i.exec(body))){const q=m[1].split(/\s*,\s*|\s+/),pc=q[0].includes('%');rgb=q.map(v=>parseFloat(v)/(pc?100:255))}
    const dark=rgb!==null&&0.2126*lin(rgb[0])+0.7152*lin(rgb[1])+0.0722*lin(rgb[2])<0.18;
    root.dataset.livery=k.slug;root.dataset.scheme=dark?'dark':'light';css.setProperty('color-scheme',dark?'dark':'light');
  }
}catch{}
`;

const SCRIPT = `
const KEY=${JSON.stringify(TOKEN_STORAGE_KEY)},FRAG=${JSON.stringify(TOKEN_FRAGMENT_KEY)};
const $=id=>document.getElementById(id);
const list=$('rooms'),note=$('note'),form=$('add'),gate=$('gate'),sum=$('sum'),title=$('title');
let token=null,rooms=null,renaming=null,removing=null,seen='',said=-1;
try{
  const h=new URLSearchParams(location.hash.slice(1));
  if(/^[0-9a-f]{64}$/i.test(h.get(FRAG)||'')){token=h.get(FRAG);try{localStorage.setItem(KEY,token)}catch{}history.replaceState(null,'',location.pathname)}
  else token=localStorage.getItem(KEY);
}catch{}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function key(label,kind,fn,f,aria){const b=el('button','btn',label);b.type='button';if(kind)b.dataset.kind=kind;if(f)b.dataset.f=f;if(aria)b.setAttribute('aria-label',aria);b.addEventListener('click',fn);return b}
function ago(at){
  const s=Math.max(0,(Date.now()-at)/1000);
  if(s<45)return 'just now';if(s<3300)return Math.round(s/60)+' min ago';if(s<84600)return Math.round(s/3600)+' h ago';return Math.round(s/86400)+' d ago';
}
async function call(method,path,body){
  const res=await fetch(path,{method,headers:Object.assign(token?{Authorization:'Bearer '+token}:{},body?{'Content-Type':'application/json'}:{}),body:body?JSON.stringify(body):undefined,cache:'no-store'});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.error||('error '+res.status));
  return data;
}
function fail(e){note.textContent=e instanceof Error?e.message:String(e);note.hidden=false}
function clear(){note.textContent='';note.hidden=true}
function shut(text,body){gate.hidden=false;gate.querySelector('h2').textContent=text;gate.querySelector('p').textContent=body;form.hidden=true;list.replaceChildren();sum.replaceChildren();$('loading').hidden=true;$('new').disabled=true}
function kindOf(r){
  if(r.state==='crashed'||r.state==='stopped'||r.state==='starting')return r.state;
  return r.needsYou?'needs':r.working?'working':'';
}
const WORD={needs:'NEEDS YOU',working:'WORKING',crashed:'CRASHED',stopped:'STOPPED',starting:'STARTING','':'RUNNING'};
function card(r){
  const kind=kindOf(r),up=r.state==='running',name=r.name||r.id,li=el('li','tile room-tile rl-card');
  if(kind)li.dataset.kind=kind;
  const head=el('div','tile-head'),led=el('span','led');
  led.dataset.on=String(kind!=='stopped');if(kind==='needs'||kind==='starting')led.dataset.blink='true';
  head.append(led);
  if(renaming===r.id){
    const input=el('input','input');input.value=r.name;input.maxLength=40;input.dataset.f='name:'+r.id;input.setAttribute('aria-label','New name of '+name);
    const save=async()=>{try{await call('PATCH','/api/rooms/'+encodeURIComponent(r.id),{name:input.value});renaming=null;clear();load()}catch(e){fail(e)}};
    input.addEventListener('keydown',e=>{if(e.key==='Enter')save();if(e.key==='Escape'){renaming=null;draw();focus('rename:'+r.id)}});
    const row=el('div','rl-keys');
    row.append(input,key('SAVE','primary',save,'save:'+r.id),key('CANCEL','',()=>{renaming=null;draw();focus('rename:'+r.id)},'cancel:'+r.id));
    li.append(row);
    return li;
  }
  head.append(el('h3','tile-legend rl-name',name),el('span','tile-state',WORD[kind]));
  li.append(head);
  const lcd=el('div','tile-lcd');
  if(up&&r.agents!==null){
    lcd.append(el('span','tile-sub',r.agents===0?'no agents yet':r.running+' of '+r.agents+' agents running'));
    const parts=[];if(r.needsYou)parts.push(r.needsYou+' need you');if(r.working)parts.push(r.working+' working');
    if(parts.length)lcd.append(el('span','tile-sub',parts.join(' \\u00b7 ')));
    if(typeof r.costToday==='number'&&r.costToday>0)lcd.append(el('span','tile-sub','about $'+r.costToday.toFixed(2)+' today (estimate)'));
    if(r.lastActivity){const t=el('span','tile-sub','last activity '+ago(r.lastActivity));t.dataset.at=String(r.lastActivity);lcd.append(t)}
  }else if(up)lcd.append(el('span','tile-sub','running'));
  else{lcd.append(el('span','tile-sub',r.state==='crashed'?'crashed, starting again':r.state==='starting'?'starting':'stopped'));if(r.note)lcd.append(el('span','tile-sub',r.note))}
  li.append(lcd);
  const foot=el('div','tile-foot');foot.append(el('span','','r/'+r.id));if(r.tabName)foot.append(el('span','','tab: '+r.tabName));
  li.append(foot);
  const keys=el('div','rl-keys');
  if(up){const a=el('a','btn','OPEN');a.dataset.kind='primary';a.dataset.f='open:'+r.id;a.href='/r/'+encodeURIComponent(r.id)+'/';a.setAttribute('aria-label','Open '+name);keys.append(a);
    // a tap anywhere on a running room's card opens it (the OPEN key stays the one for a keyboard and a screen reader)
    li.className+=' rl-open';li.addEventListener('click',e=>{if(!e.target.closest('a,button,input'))location.assign(a.href)})}
  else{const b=key('OPEN','primary',()=>{},'open:'+r.id,'Open '+name);b.disabled=true;keys.append(b)}
  if(r.id!=='main'){keys.append(key('RENAME','',()=>{renaming=r.id;removing=null;draw();focus('name:'+r.id)},'rename:'+r.id,'Rename '+name),key('REMOVE','danger',()=>{removing=r.id;renaming=null;draw();focus('keep:'+r.id)},'remove:'+r.id,'Remove '+name))}
  li.append(keys);
  if(removing===r.id){
    const box=el('div','flood rl-confirm');box.dataset.tone='nogo';box.setAttribute('role','group');box.setAttribute('aria-label','Remove '+name);
    box.append(el('p','','Remove '+name+'? gonogo stops the room and its agents. Its folder stays on disk (rooms/'+r.id+'); nothing is deleted.'));
    const row=el('div','rl-keys');
    row.append(key('KEEP','',()=>{removing=null;draw();focus('remove:'+r.id)},'keep:'+r.id,'Keep '+name),key('REMOVE','danger',async()=>{try{await call('DELETE','/api/rooms/'+encodeURIComponent(r.id));removing=null;clear();load();title.focus()}catch(e){fail(e)}},'confirm:'+r.id,'Remove '+name+' now'));
    box.append(row);li.append(box);
  }
  return li;
}
function focus(f){const t=list.querySelector('[data-f="'+f+'"]');if(t){t.focus();if(t.select)t.select()}return !!t}
function draw(){
  const had=document.activeElement&&list.contains(document.activeElement)?document.activeElement.dataset.f:null;
  const cards=rooms.map(card);
  if(rooms.length===1){
    const open=el('li','tile rl-card rl-new');open.dataset.kind='open';
    open.append(el('span','tile-legend','Only main so far'),el('span','tile-sub','Another room has its own agents, folder and token. Nothing is shared.'),key('NEW ROOM','',showForm,'empty-new'));
    cards.push(open);
  }
  list.replaceChildren(...cards);
  const needs=rooms.reduce((n,r)=>n+(r.needsYou||0),0);
  sum.replaceChildren(el('span','chip',rooms.length+(rooms.length===1?' room':' rooms')));
  if(needs){const c=el('span','chip',needs+' need you');c.dataset.tone='amber';sum.append(c)}
  // said aloud only when the count changes, not at every redraw
  if(needs!==said){said=needs;$('live').textContent=needs===0?'No room needs you.':needs+(needs===1?' agent needs you.':' agents need you.')}
  document.title=(needs?'('+needs+') ':'')+'rooms \\u00b7 gonogo';
  $('loading').hidden=true;
  if(had&&!focus(had))title.focus();
}
function showForm(){form.hidden=false;$('new').setAttribute('aria-expanded','true');form.elements.id.focus()}
function hideForm(){form.hidden=true;form.reset();$('new').setAttribute('aria-expanded','false');$('new').focus()}
function tick(){for(const t of list.querySelectorAll('[data-at]'))t.textContent='last activity '+ago(Number(t.dataset.at))}
async function load(){
  try{
    const res=await fetch('/api/rooms',{headers:token?{Authorization:'Bearer '+token}:{},cache:'no-store'});
    // no token, or one that no longer opens anything: the login (which says "set up" on an install with no account yet)
    if(res.status===401){location.replace('/login');return}
    const next=(await res.json()).rooms||[],text=JSON.stringify(next);
    rooms=next;
    // while a name is being typed the cards stay as they are; the next poll draws what changed
    if(text!==seen&&renaming===null){seen=text;draw()}
  }catch{if(rooms===null)shut('Could not reach the server','Is gonogo still running? This page asks again in a few seconds.');else fail('Could not reach the server.')}
}
$('new').addEventListener('click',()=>form.hidden?showForm():hideForm());
$('cancel').addEventListener('click',hideForm);
form.addEventListener('keydown',e=>{if(e.key==='Escape')hideForm()});
form.addEventListener('submit',async e=>{
  e.preventDefault();
  const id=form.elements.id.value.trim(),name=form.elements.name.value.trim();
  try{await call('POST','/api/rooms',name?{id,name}:{id});form.reset();form.hidden=true;$('new').setAttribute('aria-expanded','false');clear();seen='';await load();focus('open:'+id)}catch(err){fail(err)}
});
load();setInterval(load,5000);setInterval(tick,30000);
`;

const hash = (text: string): string => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The name of the built client's stylesheet (`assets/index-<hash>.css`), or null when there is no built client. */
export function clientStylesheet(staticDir: string | null): string | null {
  if (staticDir === null || !existsSync(join(staticDir, 'index.html'))) return null;
  const found = /<link[^>]*rel="stylesheet"[^>]*href="\.\/assets\/([\w.-]+\.css)"/.exec(readFileSync(join(staticDir, 'index.html'), 'utf8'));
  return found?.[1] ?? null;
}

export const roomsPageHeaders = (): Record<string, string> => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': `default-src 'none'; script-src ${hash(LIVERY)} ${hash(SCRIPT)}; style-src 'self' ${hash(STYLE)}; font-src 'self' data:; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
});

const CHANGELOG_URL = 'https://github.com/ulm0/gonogo/blob/main/CHANGELOG.md';

export const roomsPage = (stylesheet: string | null, version: string | null = null): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>rooms · gonogo</title>${
    stylesheet === null ? '' : `<link rel="stylesheet" href="/rooms/assets/${stylesheet}">`
  }<style>${STYLE}</style><script>${LIVERY}</script></head><body>` +
  `<header class="topbar"><h1 class="mark"><img class="mark-name" src="/rooms/lockup.svg" alt="gonogo"><span class="label mark-unit">ROOMS</span></h1>${version === null ? '' : `<span class="topbar-version"><a class="version-mark" href="${CHANGELOG_URL}" target="_blank" rel="noreferrer noopener" aria-label="gonogo ${esc(version)}, open the changelog">${esc(version)}</a></span>`}<span class="topbar-grow"></span><button id="new" type="button" class="btn" data-kind="primary" aria-expanded="false" aria-controls="add">NEW ROOM</button></header>` +
  `<main class="rl-main">` +
  `<div class="rl-head"><h2 id="title" class="label" tabindex="-1">Rooms</h2><span id="sum"></span><span id="live" class="sr-only" role="status"></span></div>` +
  `<section id="gate" class="module rl-gate" hidden><h2 class="label"></h2><p class="hint"></p></section>` +
  `<p id="loading" class="hint">Asking the rooms…</p>` +
  `<form id="add" class="module rl-form" hidden><span class="label">NEW ROOM</span><div class="rl-fields"><label><span class="label">ID</span><input class="input" name="id" required maxlength="24" pattern="[a-z][a-z0-9-]{0,23}" aria-describedby="idhint" autocomplete="off" spellcheck="false"><span id="idhint" class="hint">Lowercase letters, digits and dashes, like team-a. It is the folder and the address.</span></label><label><span class="label">NAME (OPTIONAL)</span><input class="input" name="name" maxlength="40" autocomplete="off"></label></div><div class="rl-keys"><button class="btn" data-kind="primary" type="submit">ADD ROOM</button><button id="cancel" class="btn" type="button">CANCEL</button></div></form>` +
  `<p id="note" class="error rl-error" role="alert" hidden></p>` +
  `<ul id="rooms" class="rl-cards" aria-labelledby="title"></ul>` +
  `</main><script>${SCRIPT}</script></body></html>`;
