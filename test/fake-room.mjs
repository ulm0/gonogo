// A stand-in for one room of the rooms supervisor: prints the same ready line as gonogo, keeps its own token, answers /api/state with a
// token check, and ends on SIGTERM after leaving a marker. FAKE_ROOM_CRASH_ONCE=<file>: exits 1 right after starting, once.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = args[args.indexOf('--home') + 1];
mkdirSync(home, { recursive: true });
const tokenFile = join(home, 'token');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('hex') + '\n');
const token = readFileSync(tokenFile, 'utf8').trim();
writeFileSync(join(home, 'started-with'), JSON.stringify({ args, home: process.env.GONOGO_HOME, port: process.env.GONOGO_PORT ?? null }));

const server = http.createServer((req, res) => {
  const ok = req.headers.authorization === `Bearer ${token}`;
  if (req.url === '/api/state') {
    if (!ok) return void res.writeHead(401).end('no');
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ agents: [{ name: 'ana', state: 'idle' }, { name: 'ben', state: 'needs_you' }] }));
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(`<p>room at ${home}</p>`);
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`gonogo ready: http://127.0.0.1:${server.address().port}/#token=${token}\n`);
  const crash = process.env.FAKE_ROOM_CRASH_ONCE;
  if (crash && !existsSync(crash)) {
    writeFileSync(crash, 'x');
    setTimeout(() => process.exit(1), 300);
  }
});
process.on('SIGTERM', () => {
  writeFileSync(join(home, 'stopped'), 'graceful');
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
