// A stand-in for one room of the rooms supervisor: prints the same ready line as gonogo, answers /api/state on its unix socket only (the page's
// door has no TCP credential; docs/login-spec.md R8), and ends on SIGTERM after leaving a marker. FAKE_ROOM_CRASH_ONCE=<file>: exits 1 right after starting, once.
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = args[args.indexOf('--home') + 1];
mkdirSync(home, { recursive: true });
mkdirSync(join(home, 'run'), { recursive: true, mode: 0o700 });
const sockPath = join(home, 'run', 'room.sock');
fs.rmSync(sockPath, { force: true });
writeFileSync(join(home, 'started-with'), JSON.stringify({ args, home: process.env.GONOGO_HOME, port: process.env.GONOGO_PORT ?? null, supervisor: process.env.GONOGO_SUPERVISOR_PID ?? null, reloaded: process.env.GONOGO_RELOADED ?? null, env: Object.keys(process.env).filter((k) => /token/i.test(k)) }));

// every start leaves a line, and a dump of what this process was given (the Director token must be nowhere in it)
fs.appendFileSync(join(home, 'starts'), `${process.pid} ${Date.now()}\n`);
fs.writeFileSync(join(home, 'dump.json'), JSON.stringify({ args, env: process.env }));

if (process.env.FAKE_ROOM_FAIL) {
  process.stderr.write(`gonogo: ${process.env.FAKE_ROOM_FAIL} #token=${"f".repeat(64)}\n`);
  process.exit(1);
}
const server = http.createServer((req, res) => {
  // a request on the unix socket has no remote address; one on TCP has no way in
  const ok = req.socket.remoteAddress === undefined;
  if (req.url === '/api/state') {
    if (!ok) return void res.writeHead(401).end('no');
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ propellant: { cost: { days: [{ usd: 0.12 }, { usd: 1.5 }] } }, agents: [{ name: 'ana', state: 'working', stateSince: 1_700_000_000_000 }, { name: 'ben', state: 'needs_you', stateSince: 1_700_000_500_000 }], activity: [{ at: 1_700_000_900_000 }], poll: process.env.FAKE_ROOM_POLL_OPEN && home.includes('/rooms/') ? { status: 'open' } : null, tabName: { name: process.env.FAKE_TAB || 'Fake tab', fallback: null } }));
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(`<p>room at ${home}</p>`);
});
// a socket that stays open until the other side ends it (the proxy tests need one through the whole supervisor)
const socketServer = http.createServer(server.listeners('request')[0]);
const wss = new WebSocketServer({ noServer: true, handleProtocols: (set) => (set.has('gonogo.v1') ? 'gonogo.v1' : false) });
server.on('upgrade', (req, socket, head) => {
  const offered = String(req.headers['sec-websocket-protocol'] ?? '');
  if (req.socket.remoteAddress !== undefined || offered.includes('token.')) return void socket.destroy();
  wss.handleUpgrade(req, socket, head, () => undefined);
});
socketServer.on('upgrade', (...a) => server.listeners('upgrade')[0](...a));
// FAKE_ROOM_DELAY_MS: a room that takes its time to be ready (main only when FAKE_ROOM_DELAY_ONLY=main is the id of the home's folder name)
const delay = Number(process.env.FAKE_ROOM_DELAY_MS ?? 0);
setTimeout(() => server.listen(0, '127.0.0.1', () => {
  server.listen2 = true;
  socketServer.listen(sockPath, () => process.stdout.write(`gonogo ready: http://127.0.0.1:${server.address().port}/\n`));
  // what a room says on its pipe when something waits for the Director (FAKE_ROOM_PUSH is a list of lines, written as they are)
  for (const line of (process.env.FAKE_ROOM_PUSH ? JSON.parse(process.env.FAKE_ROOM_PUSH) : [])) process.stdout.write(line + '\n');
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
  // the supervisor's alerts come as `gonogo-alert "text"` lines: kept for the tests to read
  process.stdin.on('data', (d) => { for (const line of String(d).split('\n')) if (line.startsWith('gonogo-alert ')) fs.appendFileSync(join(home, 'alerts'), line.slice(13) + '\n'); });
  process.stdin.on('end', () => process.kill(process.pid, 'SIGTERM'));
  process.stdin.resume();
}
process.on('SIGTERM', () => {
  writeFileSync(join(home, 'stopped'), 'graceful');
  socketServer.close();
  socketServer.closeAllConnections();
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
