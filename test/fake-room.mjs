// A stand-in for one room of the rooms supervisor: prints the same ready line as gonogo, keeps its own token, answers /api/state with a
// token check, and ends on SIGTERM after leaving a marker. FAKE_ROOM_CRASH_ONCE=<file>: exits 1 right after starting, once.
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = args[args.indexOf('--home') + 1];
mkdirSync(home, { recursive: true });
// like the real room: its own token is run/room-token, new at every start (the Director token is <root>/token and is never read here)
mkdirSync(join(home, 'run'), { recursive: true });
const tokenFile = join(home, 'run', 'room-token');
writeFileSync(tokenFile, randomBytes(32).toString('hex') + '\n');
const token = readFileSync(tokenFile, 'utf8').trim();
writeFileSync(join(home, 'started-with'), JSON.stringify({ args, home: process.env.GONOGO_HOME, port: process.env.GONOGO_PORT ?? null, supervisor: process.env.GONOGO_SUPERVISOR_PID ?? null, reloaded: process.env.GONOGO_RELOADED ?? null, env: Object.keys(process.env).filter((k) => /token/i.test(k)) }));

// every start leaves a line, and a dump of what this process was given (the Director token must be nowhere in it)
fs.appendFileSync(join(home, 'starts'), `${process.pid} ${Date.now()}\n`);
fs.writeFileSync(join(home, 'dump.json'), JSON.stringify({ args, env: process.env }));

if (process.env.FAKE_ROOM_FAIL) {
  process.stderr.write(`gonogo: ${process.env.FAKE_ROOM_FAIL} #token=${"f".repeat(64)}\n`);
  process.exit(1);
}
const server = http.createServer((req, res) => {
  const ok = req.headers.authorization === `Bearer ${token}`;
  if (req.url === '/api/state') {
    if (!ok) return void res.writeHead(401).end('no');
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ agents: [{ name: 'ana', state: 'working', stateSince: 1_700_000_000_000 }, { name: 'ben', state: 'needs_you', stateSince: 1_700_000_500_000 }], activity: [{ at: 1_700_000_900_000 }], poll: process.env.FAKE_ROOM_POLL_OPEN && home.includes('/rooms/') ? { status: 'open' } : null, tabName: { name: process.env.FAKE_TAB || 'Fake tab', fallback: null } }));
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(`<p>room at ${home}</p>`);
});
// a socket that stays open until the other side ends it (the proxy tests need one through the whole supervisor)
const wss = new WebSocketServer({ noServer: true, handleProtocols: (set) => (set.has('gonogo.v1') ? 'gonogo.v1' : false) });
server.on('upgrade', (req, socket, head) => {
  const offered = String(req.headers['sec-websocket-protocol'] ?? '');
  if (!offered.includes(`token.${token}`)) return void socket.destroy();
  wss.handleUpgrade(req, socket, head, () => undefined);
});
// FAKE_ROOM_DELAY_MS: a room that takes its time to be ready (main only when FAKE_ROOM_DELAY_ONLY=main is the id of the home's folder name)
const delay = Number(process.env.FAKE_ROOM_DELAY_MS ?? 0);
setTimeout(() => server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`gonogo ready: http://127.0.0.1:${server.address().port}/#token=${token}\n`);
  // FAKE_ROOM_ASK=<line>: the room puts that line to its supervisor on stdout; what comes back on stdin is written to 'answer'
  if (process.env.FAKE_ROOM_ASK && (!process.env.FAKE_ROOM_ASK_ONLY || process.env.FAKE_ROOM_ASK_ONLY === process.env.GONOGO_ROOM)) {
    process.stdin.on('data', (d) => fs.appendFileSync(join(home, 'answer'), d));
    setTimeout(() => process.stdout.write(process.env.FAKE_ROOM_ASK + '\n'), 300);
  }
  // a room that leaves with 75 although nobody asked it to
  if (process.env.FAKE_ROOM_EXIT75) setTimeout(() => process.exit(75), 200);
  const crash = process.env.FAKE_ROOM_CRASH_ONCE;
  if (crash && !existsSync(crash)) {
    writeFileSync(crash, 'x');
    setTimeout(() => process.exit(1), 300);
  }
}), delay);
// SIGUSR2 is a reload: leave a marker and exit 75, as a real room under the supervisor does
process.on('SIGUSR2', () => {
  writeFileSync(join(home, 'reloaded'), 'yes');
  process.exit(75);
});
// --exit-with-stdin: the supervisor's end of the pipe closing is a graceful stop, as for a real room
if (args.includes('--exit-with-stdin')) {
  process.stdin.on('end', () => process.kill(process.pid, 'SIGTERM'));
  process.stdin.resume();
}
process.on('SIGTERM', () => {
  writeFileSync(join(home, 'stopped'), 'graceful');
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
