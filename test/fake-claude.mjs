// Stand-in for `claude` (contract section 9). It runs in a pty exactly where claude would, parses exactly the argv of 7.2,
// draws a screen that analyzeScreen and the ready rule accept, posts the same hooks, calls the same MCP tools and exits the
// same ways, so the e2e test can drive the real server paths (launcher files, token, hook transport, MCP, pointer typing,
// terminal host, hub) without a model. Plain ESM for Node 24; the only dependency is the MCP SDK, loaded lazily.
// Like claude it keeps session transcripts under $CLAUDE_CONFIG_DIR/projects (default ~/.claude/projects) and the launcher
// looks there too, so when you run it by hand set CLAUDE_CONFIG_DIR to a scratch directory, or it writes into your own.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import dns from 'node:dns';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Node opens each tty stream on its first use, and open() on a pty whose master has gone blocks for ever (macOS), SIGHUP
// handler included: the stand-in would outlive a crashed server. Touch all three now, while the terminal is alive.
void [process.stdin, process.stdout, process.stderr];

const ESC = '\x1b';
const BEL = '\x07';
const NBSP = ' ';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
];
const ALLOWED_TOOLS = [
  'mcp__gonogo__send_message',
  'mcp__gonogo__list_roster',
  'mcp__gonogo__read_messages',
  'mcp__gonogo__go_nogo',
  'mcp__gonogo__task_list',
  'mcp__gonogo__task_create',
  'mcp__gonogo__task_update',
  'mcp__gonogo__log_write',
  'mcp__gonogo__log_search',
  'mcp__gonogo__log_read',
  'mcp__gonogo__livery_submit',
  'mcp__gonogo__hire_agent',
];
const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions'];
const POINTER_RE = /^gonogo: (\d+) new messages? from (.+)\. Call read_messages\.$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Claude Code ignores the 9th consecutive Stop block (the count resets on a tool call). */
const STOP_BLOCK_CAP = 8;
/** A lone ESC cannot be told from the start of a sequence until nothing follows; a terminal waits about this long. */
const ESC_FLUSH_MS = 30;
/** Claude writes the boxed prompt about 13 ms after `ESC[?2004h`; the gap keeps "bracketed paste on" and "box on screen" two chunks. */
const BOX_AFTER_MODES_MS = 15;

const envNumber = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const envOn = (name) => ['1', 'true'].includes((process.env[name] ?? '').toLowerCase());

const READY_MS = envNumber('FAKE_CLAUDE_READY_MS', 150);
const TURN_MS = envNumber('FAKE_CLAUDE_TURN_MS', 200);
const SHELL_MS = envNumber('FAKE_CLAUDE_SHELL_MS', 1500);
const EXIT_DELAY_MS = envNumber('FAKE_CLAUDE_EXIT_DELAY_MS', 100);
const IGNORE_CR = envOn('FAKE_CLAUDE_IGNORE_CR');
const IGNORE_POINTER = envOn('FAKE_CLAUDE_IGNORE_POINTER');
const NO_HOOKS = envOn('FAKE_CLAUDE_NO_HOOKS');
const STUBBORN = envOn('FAKE_CLAUDE_STUBBORN');
const DIALOG = process.env.FAKE_CLAUDE_DIALOG ?? '';
const SESSION_DIR = process.env.FAKE_CLAUDE_SESSION_DIR || null;
// Set by test/fake-docker.mjs: the stand-in runs "in a container", where the hub is at host.docker.internal (`--add-host
// host.docker.internal:host-gateway`). The name resolves to this machine, and only that name is accepted in the generated files.
const BEHIND_DOCKER = envOn('FAKE_CLAUDE_BEHIND_DOCKER');
if (BEHIND_DOCKER) {
  const lookup = dns.lookup;
  dns.lookup = (host, ...rest) => lookup(host === 'host.docker.internal' ? '127.0.0.1' : host, ...rest);
}
const LOG_DIR = process.env.FAKE_CLAUDE_LOG_DIR || null;

/* ---- arguments (9.1): any deviation from the argv of 7.2 stops the process with exit 2 ---- */

/** Synchronous, so that the text is out before the process exits (a pipe would otherwise lose it). */
function writeNow(fd, text) {
  try {
    writeSync(fd, text);
  } catch {
    // nobody is reading
  }
}

function die(message) {
  writeNow(2, `fake-claude: ${message}\n`);
  process.exit(2);
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseArgv(args) {
  const out = {
    sessionId: null,
    resume: null,
    mode: null,
    settings: null,
    mcpConfig: null,
    role: null,
    snapshot: null,
    strict: false,
    allowed: null,
    pluginDir: null,
    model: null,
  };
  const seen = new Set();
  const valueOf = (flag, index) => {
    if (index + 1 >= args.length) die(`${flag} needs a value`);
    return args[index + 1];
  };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (seen.has(flag)) die(`${flag} given twice`);
    seen.add(flag);
    switch (flag) {
      case '--session-id':
        out.sessionId = valueOf(flag, i);
        i += 1;
        break;
      case '--resume':
        out.resume = valueOf(flag, i);
        i += 1;
        break;
      case '--permission-mode':
        out.mode = valueOf(flag, i);
        i += 1;
        break;
      case '--settings':
        out.settings = valueOf(flag, i);
        i += 1;
        break;
      case '--mcp-config':
        out.mcpConfig = valueOf(flag, i);
        i += 1;
        break;
      case '--append-system-prompt':
        out.role = valueOf(flag, i);
        i += 1;
        break;
      case '--system-prompt-snapshot':
        out.snapshot = valueOf(flag, i);
        i += 1;
        break;
      case '--strict-mcp-config':
        out.strict = true;
        break;
      case '--plugin-dir':
        out.pluginDir = valueOf(flag, i);
        i += 1;
        break;
      case '--model':
        out.model = valueOf(flag, i);
        i += 1;
        break;
      case '--allowedTools': {
        // variadic: values run until the next flag
        const values = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          values.push(args[i + 1]);
          i += 1;
        }
        if (values.length === 0) die('--allowedTools needs at least one value');
        out.allowed = values;
        break;
      }
      default:
        die(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  if (out.sessionId !== null && out.resume !== null) die('--session-id and --resume are exclusive');
  const id = out.sessionId ?? out.resume;
  if (id === null) die('missing --session-id or --resume');
  if (!UUID_RE.test(id)) die(`the session id is not a UUID: ${id}`);
  if (out.mode === null) die('missing --permission-mode');
  if (!PERMISSION_MODES.includes(out.mode)) die(`bad --permission-mode ${JSON.stringify(out.mode)}`);
  if (out.settings === null) die('missing --settings');
  if (!out.strict) die('missing --strict-mcp-config');
  if (out.mcpConfig === null) die('missing --mcp-config');
  if (out.role === null || out.role.trim() === '') die('missing or empty --append-system-prompt');
  if (out.snapshot !== 'off') die('missing --system-prompt-snapshot off');
  if (out.allowed === null) die('missing --allowedTools');
  if ([...out.allowed].sort().join(' ') !== [...ALLOWED_TOOLS].sort().join(' ')) {
    die(`--allowedTools must list exactly ${ALLOWED_TOOLS.join(' ')}`);
  }
  return out;
}

function loadJsonObject(path, flag) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    die(`${flag} file cannot be read: ${path} (${error.message})`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    die(`${flag} file is not valid JSON: ${path} (${error.message})`);
  }
  if (!isObject(value)) die(`${flag} file is not a JSON object: ${path}`);
  return value;
}

function parseLoopbackUrl(text, what) {
  let url;
  try {
    url = new URL(text);
  } catch {
    die(`${what} is not a URL: ${String(text)}`);
  }
  // claude blocks http hooks to private addresses, so a URL that is not loopback would silence every hook
  const hosts = BEHIND_DOCKER ? ['host.docker.internal'] : ['127.0.0.1', '[::1]'];
  if (url.protocol !== 'http:' || !hosts.includes(url.hostname)) {
    die(`${what} is not a ${BEHIND_DOCKER ? 'host.docker.internal' : 'loopback'} http URL: ${text}`);
  }
  return url;
}

/** Everything the fake needs from settings.json: one http handler per event, all for one agent, all on loopback. */
function readHooks(settings) {
  const hooks = settings.hooks;
  if (!isObject(hooks)) die('settings.json has no "hooks" object');
  const extra = Object.keys(hooks).filter((key) => !HOOK_EVENTS.includes(key));
  if (extra.length > 0) die(`settings.json registers unexpected hook events: ${extra.join(', ')}`);
  const byEvent = {};
  let name = null;
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups) || groups.length !== 1) die(`settings.json hooks.${event} must hold exactly one group`);
    const handlers = groups[0]?.hooks;
    if (!Array.isArray(handlers) || handlers.length !== 1) die(`settings.json hooks.${event} must hold exactly one handler`);
    const handler = handlers[0];
    if (!isObject(handler) || handler.type !== 'http' || typeof handler.url !== 'string') {
      die(`settings.json hooks.${event} must be an http handler with a url`);
    }
    const url = parseLoopbackUrl(handler.url, `the url of hooks.${event}`);
    const match = /^\/hook\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (match === null || match[2] !== event) die(`the url of hooks.${event} must end in /hook/<name>/${event}: ${handler.url}`);
    if (name !== null && name !== match[1]) die('settings.json hook urls name different agents');
    name = match[1];
    if (typeof handler.timeout !== 'number' || !(handler.timeout > 0)) die(`hooks.${event} needs a positive timeout in seconds`);
    byEvent[event] = {
      url: handler.url,
      timeoutMs: handler.timeout * 1000,
      headers: isObject(handler.headers) ? handler.headers : {},
      // a variable that is not listed expands to nothing, like in claude: the server then answers 401
      allowed: Array.isArray(handler.allowedEnvVars) ? handler.allowedEnvVars.filter((v) => typeof v === 'string') : [],
    };
  }
  return { name, byEvent };
}

/** Payload: --plugin-dir names a plugin folder with a manifest and one SKILL.md per skill (symlinks are followed, as claude does). */
function readPlugin(dir) {
  const manifest = loadJsonObject(join(dir, '.claude-plugin', 'plugin.json'), '--plugin-dir manifest');
  if (typeof manifest.name !== 'string' || manifest.name === '') die('the plugin manifest needs a name');
  const skills = readdirSync(join(dir, 'skills')).sort();
  for (const skill of skills) {
    if (!existsSync(join(dir, 'skills', skill, 'SKILL.md'))) die(`the plugin skill ${skill} has no SKILL.md`);
  }
  return { name: manifest.name, skills };
}

function readMcpServer(config) {
  const servers = config.mcpServers;
  if (!isObject(servers) || !isObject(servers.gonogo)) die('mcp.json must hold the server "gonogo"');
  // Payload servers sit beside it and are not started here; each must be a stdio or http or sse entry of mcp.json.
  for (const [key, server] of Object.entries(servers)) {
    if (key === 'gonogo') continue;
    const type = isObject(server) ? server.type ?? 'stdio' : null;
    const ok = type === 'stdio' ? typeof server.command === 'string' : (type === 'http' || type === 'sse') && typeof server.url === 'string';
    if (!ok) die(`mcp.json server ${key} is not a stdio, http or sse entry`);
  }
  const gonogo = servers.gonogo;
  if (!isObject(gonogo) || gonogo.type !== 'http' || typeof gonogo.url !== 'string') die('mcp.json gonogo must be {"type":"http","url":...}');
  const url = parseLoopbackUrl(gonogo.url, 'the MCP url');
  if (url.pathname !== '/mcp') die(`the MCP url must end in /mcp: ${gonogo.url}`);
  if (!isObject(gonogo.headers)) die('mcp.json gonogo needs a headers object');
  return { url: gonogo.url, headers: gonogo.headers, names: Object.keys(servers) };
}

const opts = parseArgv(process.argv.slice(2));
const { name: agentName, byEvent: hookConfig } = readHooks(loadJsonObject(opts.settings, '--settings'));
const mcpServer = readMcpServer(loadJsonObject(opts.mcpConfig, '--mcp-config'));
const plugin = opts.pluginDir === null ? null : readPlugin(opts.pluginDir);
if (DIALOG !== '' && DIALOG !== 'trust' && DIALOG !== 'bypass') die(`FAKE_CLAUDE_DIALOG must be trust or bypass, not ${DIALOG}`);

/* ---- the assertion log (9.9): the e2e test reads what the agent saw ---- */

let logReady = false;
function log(entry) {
  if (LOG_DIR === null) return;
  try {
    if (!logReady) {
      mkdirSync(LOG_DIR, { recursive: true });
      logReady = true;
    }
    appendFileSync(join(LOG_DIR, `${agentName}.jsonl`), `${JSON.stringify(entry)}\n`);
  } catch {
    // a log that cannot be written must not change what the agent does
  }
}

// before the session check, so that a start that exits 1 is visible too
log({ e: 'start', plugin, servers: mcpServer.names, argv: process.argv.slice(2), tokenLength: (process.env.GONOGO_TOKEN ?? '').length, cwd: process.cwd(), pid: process.pid, model: opts.model, openaiKey: process.env.OPENAI_API_KEY ?? null });

/* ---- session emulation (9.2) ---- */

let sessionId = opts.sessionId ?? opts.resume;
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

function findTranscript(id) {
  if (SESSION_DIR !== null) {
    const path = join(SESSION_DIR, `${id}.jsonl`);
    return existsSync(path) ? path : null;
  }
  const root = join(configDir, 'projects');
  let projects = [];
  try {
    projects = readdirSync(root);
  } catch {
    // no projects directory yet: nothing exists
  }
  for (const project of projects) {
    const path = join(root, project, `${id}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

function refuseSession(text) {
  writeNow(1, `${text}\r\n`);
  log({ e: 'exit', code: 1 });
  process.exit(1);
}

const existing = findTranscript(sessionId);
if (opts.sessionId !== null && existing !== null) refuseSession(`Error: Session ID ${sessionId} is already in use.`);
if (opts.resume !== null && existing === null) refuseSession(`No conversation found with session ID: ${sessionId}`);

const transcriptPath =
  existing ??
  (SESSION_DIR !== null
    ? join(SESSION_DIR, `${sessionId}.jsonl`)
    : join(configDir, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`));

/** Like claude: the transcript appears when the first prompt is submitted, not at start. */
function ensureTranscript() {
  if (existsSync(transcriptPath)) return;
  try {
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, '{}\n', { mode: 0o600 });
  } catch (error) {
    log({ e: 'error', message: `transcript: ${error.message}` });
  }
}

/* ---- state ---- */

let screen = 'none'; // none | startup | main
let inputEnabled = false;
let altScreen = false;
let modesOn = false;
let title = null;
let input = '';
let placeholderLive = true; // until the first keystroke or the first submitted prompt (lead ruling 12)
let footer = '  ? for shortcuts';
let footerTimer = null;
let dialog = null; // { lines, resolve, kind, tool }: a permission-like dialog replaces the box
let startup = null; // { kind, selected }: the trust or bypass dialog before the REPL
let lastLoggedSize = '';
let turn = null; // { aborted, wake }: a model turn or a shell command is running
let workTimer = null;
let workGlyph = '◐';
let askedCtrlCAt = 0;
let promptId = randomUUID();
let stopBlocksInRow = 0;
let clientPromise = null;
const transcript = [];
const queuedPrompts = []; // claude queues a prompt typed while it works and submits it afterwards
const effort = { level: 'medium' };

/* ---- output and the screen (9.3) ---- */

const write = (text) => {
  try {
    process.stdout.write(text);
  } catch {
    // the pty is gone: SIGHUP follows
  }
};
const columns = () => Math.max(process.stdout.columns || 120, 20);
const rowCount = () => Math.max(process.stdout.rows || 40, 5);
const clip = (text, width) => (text.length > width ? text.slice(0, width) : text);
/** Pasted or sent text is drawn as characters, never as terminal controls: an ESC in a paste must not drive the screen. */
const printable = (text) => text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');

function logSize() {
  const key = `${columns()}x${rowCount()}`;
  if (key === lastLoggedSize) return;
  lastLoggedSize = key;
  log({ e: 'resize', cols: columns(), rows: rowCount() });
}

function setTitle(text) {
  if (text === title) return;
  title = text;
  write(`${ESC}]0;${text}${BEL}`);
}

function inputShown(width) {
  const flat = printable(input.replace(/\n/g, '↵'));
  const room = width - 3;
  return flat.length > room ? `…${flat.slice(flat.length - room + 1)}` : flat;
}

/** Rows R-3 to R: rule, prompt row (`❯` + NBSP + text), rule, footer; the cursor ends after the text. */
function boxText() {
  const width = columns();
  const last = rowCount();
  const rule = '─'.repeat(width);
  const empty = input === '';
  const shown = inputShown(width);
  const text = empty && placeholderLive ? `${ESC}[2mTry "fake placeholder"${ESC}[22m` : shown;
  const col = empty ? 3 : Math.min(3 + shown.length, width);
  return (
    `${ESC}[${last - 3};1H${ESC}[K${rule}` +
    `${ESC}[${last - 2};1H${ESC}[K❯${NBSP}${text}` +
    `${ESC}[${last - 1};1H${ESC}[K${rule}` +
    `${ESC}[${last};1H${ESC}[K${footer}` +
    `${ESC}[${last - 2};${col}H`
  );
}

function startupLines() {
  const heading =
    startup.kind === 'trust'
      ? ' Quick safety check: Is this a project you created or one you trust?'
      : ' WARNING: Claude Code running in Bypass Permissions mode';
  const yes = startup.kind === 'trust' ? 'Yes, I trust this folder' : 'Yes, I accept';
  const mark = (row) => (startup.selected === row ? '❯ ' : '  ');
  return [heading, '', ` ${process.cwd()}`, '', `${mark(1)}No, exit`, `${mark(2)}${yes}`, '', ' Enter to confirm · Esc to cancel'];
}

function paintAll() {
  if (screen === 'none') return;
  const width = columns();
  const last = rowCount();
  let out = `${ESC}[2J`;
  const put = (row, text) => {
    out += `${ESC}[${row};1H${ESC}[K${text}`;
  };
  if (screen === 'startup') {
    startupLines().forEach((line, i) => put(i + 1, clip(line, width)));
    write(out);
    return;
  }
  const bottom = dialog === null ? 4 : dialog.lines.length;
  const bottomTop = last - bottom + 1;
  const header = [' ▐▛███▛█   Claude Code v0.0.0-fake', '▝▜██████▀  Fake model', ` ▝▝   ▝▝   ${process.cwd()}`];
  header.forEach((line, i) => {
    if (i + 1 < bottomTop) put(i + 1, clip(line, width));
  });
  const room = bottomTop - 1 - 4;
  if (room > 0) transcript.slice(-room).forEach((line, i) => put(5 + i, clip(line, width)));
  if (dialog === null) {
    write(out + boxText());
  } else {
    dialog.lines.forEach((line, i) => put(bottomTop + i, clip(line, width)));
    write(`${out}${ESC}[${last};1H`);
  }
}

/** Typing only needs the box rows; everything else repaints the whole screen. */
function paintBox() {
  if (screen === 'main' && dialog === null) write(boxText());
}

function say(text) {
  transcript.push(printable(text));
  if (transcript.length > 500) transcript.shift();
  paintAll();
}

function showFooter(text) {
  clearTimeout(footerTimer);
  footer = text;
  paintBox();
  footerTimer = setTimeout(() => {
    footer = '  ? for shortcuts';
    paintBox();
  }, 1000);
}

function enableInput() {
  if (inputEnabled) return;
  inputEnabled = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  // the pty master closed: nobody drives this terminal any more (SIGHUP normally comes first)
  process.stdin.on('error', () => process.exit(129));
  process.stdin.on('end', () => process.exit(129));
  process.stdin.resume();
}

function showStartupDialog() {
  startup = { kind: DIALOG, selected: 1 };
  screen = 'startup';
  enableInput();
  log({ e: 'dialog', kind: DIALOG, action: 'shown' });
  paintAll();
}

function startMain() {
  enableInput();
  startup = null;
  screen = 'none'; // nothing is drawn until the box is, so a resize in between has nothing to repaint
  modesOn = true;
  altScreen = true;
  // one chunk, in the order claude writes it: raw mode on, title, alternate screen with mouse reporting
  write(
    `${ESC}[?2004h${ESC}[?2031h${ESC}[?1004h${ESC}]0;✳ Claude Code${BEL}` +
      `${ESC}[?1049h${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h`,
  );
  title = '✳ Claude Code';
  setTimeout(() => {
    screen = 'main';
    logSize();
    paintAll();
    void mcpClient().catch((error) => log({ e: 'mcp', error: String(error?.message ?? error) }));
  }, BOX_AFTER_MODES_MS);
}

/* ---- leaving ---- */

function leave(code, hint) {
  clearInterval(workTimer);
  const parts = [];
  if (altScreen) parts.push(`${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l${ESC}[?1049l`);
  if (modesOn) parts.push(`${ESC}[?1004l${ESC}[?2031l${ESC}[?2004l`);
  parts.push(`${ESC}]0;${BEL}`); // claude sets an empty title on exit
  if (hint) parts.push(`Resume this session with:\r\nclaude --resume ${sessionId}\r\n`);
  write(parts.join(''));
  log({ e: 'exit', code });
  process.exit(code);
}

process.on('SIGHUP', () => {
  log({ e: 'exit', code: 129 });
  process.exit(129);
});
if (STUBBORN) {
  process.on('SIGTERM', () => log({ e: 'sigterm', ignored: true }));
} else {
  process.on('SIGTERM', () => {
    setTimeout(() => leave(143, true), EXIT_DELAY_MS);
  });
}
process.on('uncaughtException', (error) => {
  log({ e: 'error', message: String(error?.stack ?? error) });
  writeNow(2, `fake-claude: ${error?.stack ?? error}\n`);
  process.exit(70);
});
process.stdout.on('error', () => undefined);
process.stdout.on('resize', () => {
  logSize();
  paintAll();
});

/* ---- hooks (9.6) ---- */

/** `$NAME` and `${NAME}` are replaced from the environment, only for listed names when a list is given. */
function expand(value, allowed) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => {
    const variable = braced ?? bare;
    if (allowed !== null && !allowed.includes(variable)) return '';
    return process.env[variable] ?? '';
  });
}

/** Only the reply to Stop is interpreted by the caller; every failure is a non-blocking error, as in claude. */
async function hook(event, fields = {}) {
  if (NO_HOOKS) return null;
  const config = hookConfig[event];
  const headers = { 'content-type': 'application/json' };
  for (const [key, value] of Object.entries(config.headers)) headers[key] = expand(String(value), config.allowed);
  const body = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: process.cwd(),
    prompt_id: promptId,
    permission_mode: opts.mode,
    hook_event_name: event,
    ...fields,
  };
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const text = await response.text();
    let reply = null;
    try {
      reply = text === '' ? null : JSON.parse(text);
    } catch {
      // a body that is not JSON is ignored
    }
    log({ e: 'hook', event, status: response.status, reply, session: sessionId });
    return response.ok && isObject(reply) ? reply : null;
  } catch (error) {
    log({ e: 'hook', event, status: 0, error: String(error?.message ?? error), session: sessionId });
    return null;
  }
}

/* ---- MCP (9.7) ---- */

function mcpClient() {
  clientPromise ??= connectMcp().catch((error) => {
    clientPromise = null; // the first call retries
    throw error;
  });
  return clientPromise;
}

async function connectMcp() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const headers = {};
  for (const [key, value] of Object.entries(mcpServer.headers)) headers[key] = expand(String(value), null);
  const client = new Client({ name: 'fake-claude', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpServer.url), { requestInit: { headers } }));
  return client;
}

async function callMcp(name, args) {
  const started = Date.now();
  let result;
  let content = [];
  let isError = false;
  let failure = null;
  try {
    const client = await mcpClient();
    const response = await client.callTool({ name, arguments: args });
    content = Array.isArray(response.content) ? response.content : [];
    isError = response.isError === true;
    const text = content[0]?.text;
    try {
      result = JSON.parse(text);
    } catch {
      result = { raw: text ?? null };
    }
  } catch (error) {
    failure = String(error?.message ?? error);
    clientPromise = null;
    isError = true;
    result = { ok: false, error: failure };
  }
  log({ e: 'tool', name, args, result, isError });
  return { result, content, failure, ms: Date.now() - started };
}

const toolUseId = () => `toolu_${randomBytes(12).toString('hex')}`;

/** An MCP tool call, wrapped in the hooks claude fires around it. */
async function mcpTool(name, args) {
  stopBlocksInRow = 0;
  const base = {
    tool_name: `mcp__gonogo__${name}`,
    tool_input: args,
    tool_use_id: toolUseId(),
    mcp_server: { name: 'gonogo', source: 'dynamic' },
    effort,
  };
  await hook('PreToolUse', base);
  const call = await callMcp(name, args);
  if (call.failure !== null) await hook('PostToolUseFailure', { ...base, error: call.failure });
  else await hook('PostToolUse', { ...base, tool_response: call.content, duration_ms: call.ms });
  return call.result;
}

const builtinResponse = { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false };

async function builtinTool(toolName) {
  stopBlocksInRow = 0;
  const base = { tool_name: toolName, tool_input: {}, tool_use_id: toolUseId(), effort };
  await hook('PreToolUse', base);
  await hook('PostToolUse', { ...base, tool_response: builtinResponse, duration_ms: 1 });
}

/* ---- a turn (9.5) ---- */

function startWorking() {
  clearInterval(workTimer);
  workGlyph = '◐';
  setTitle('◐ Fake');
  workTimer = setInterval(() => {
    workGlyph = workGlyph === '◐' ? '◑' : '◐';
    setTitle(`${workGlyph} Fake`);
  }, 400);
}

function stopWorking() {
  clearInterval(workTimer);
  setTitle('✳ Fake');
}

const aborted = () => turn === null || turn.aborted;

/** Sleeps `ms`, or less when the turn is interrupted. */
function sleepInTurn(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (turn !== null) turn.wake = null;
      resolve();
    }
    if (turn !== null) turn.wake = done;
  });
}

/** Esc or Ctrl-C during a turn: the turn ends and, like in claude, no Stop hook fires. */
function interrupt() {
  if (turn === null) return;
  turn.aborted = true;
  if (dialog !== null) answerDialog('deny');
  turn.wake?.();
}

function askDialog(lines, kind, tool) {
  stopWorking(); // the title stays idle while a dialog waits, as in claude
  return new Promise((resolve) => {
    dialog = { lines, resolve, kind, tool };
    log({ e: 'dialog', kind, tool, action: 'shown' });
    paintAll();
  });
}

function answerDialog(answer) {
  if (dialog === null) return;
  const { resolve, kind, tool } = dialog;
  dialog = null;
  log({ e: 'dialog', kind, tool, action: answer === 'allow' ? 'allowed' : 'denied' });
  paintAll();
  resolve(answer);
}

const clampMs = (text) => {
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 600_000) : 0;
};

/** `@fake send <to> | <subject> | <body>`: the body is the whole rest of the line, so a chain nests; two parts mean `<to> | <body>`. */
function splitSend(rest) {
  const first = rest.indexOf(' | ');
  if (first === -1) return { to: rest.trim(), subject: '', body: '' };
  const to = rest.slice(0, first).trim();
  const after = rest.slice(first + 3);
  const second = after.indexOf(' | ');
  if (second === -1) return { to, subject: '', body: after };
  return { to, subject: after.slice(0, second), body: after.slice(second + 3) };
}

async function permissionDirective(rest) {
  const [tool = 'Bash', ms = '0'] = rest.split(/\s+/).filter(Boolean);
  const base = { tool_name: tool, tool_input: {}, tool_use_id: toolUseId(), effort };
  stopBlocksInRow = 0;
  await hook('PreToolUse', base);
  if (aborted()) return 'abort';
  // the dialog is drawn first and the hook follows a moment later, as in claude
  const answered = askDialog([` Do you want to run ${tool}?`, '❯ 1. Yes', '  2. No', ' Esc to cancel'], 'permission', tool);
  await hook('PermissionRequest', { ...base, permission_suggestions: [] });
  if ((await answered) === 'deny') return 'denied'; // a denial fires no hook
  startWorking();
  await sleepInTurn(clampMs(ms)); // the approved tool runs: no hook until it ends
  if (aborted()) return 'abort';
  await hook('PostToolUse', { ...base, tool_response: builtinResponse, duration_ms: clampMs(ms) });
  return 'ok';
}

/** A dialog the hooks never announce: only the screen and the title say that the agent waits. */
async function dialogDirective() {
  const answer = await askDialog([' Do you want to proceed?', '❯ 1. Yes', '  2. No', ' Esc to cancel'], 'menu', null);
  if (answer === 'deny') return 'denied';
  startWorking();
  return 'ok';
}

async function directive(name, rest) {
  switch (name) {
    case 'send': {
      const { to, subject, body } = splitSend(rest);
      await mcpTool('send_message', { to, subject, body });
      return 'ok';
    }
    case 'list':
      await mcpTool('list_roster', {});
      return 'ok';
    // `@fake vote go|no-go [reason]`: the go_nogo tool, with the rest of the line as the reason
    case 'vote': {
      const [vote = '', ...reason] = rest.split(/\s+/).filter(Boolean);
      await mcpTool('go_nogo', { vote, reason: reason.join(' ') });
      return 'ok';
    }
    // `@fake task task_list|task_create|task_update <json>` or `@fake log log_write|log_search|log_read <json>` or `@fake livery livery_submit <json>` or `@fake relief hire_agent <json>`: a Flight Plan, Mission Log, Livery or Relief tool, the JSON being its arguments
    case 'task':
    case 'log':
    case 'livery':
    case 'relief': {
      const [tool = '', ...json] = rest.split(/\s+/);
      await mcpTool(tool, json.length === 0 ? {} : JSON.parse(json.join(' ')));
      return 'ok';
    }
    case 'sleep':
      await sleepInTurn(clampMs(rest));
      return 'ok';
    case 'tool':
      await builtinTool(rest === '' ? 'Bash' : rest);
      return 'ok';
    case 'permission':
      return permissionDirective(rest);
    case 'dialog':
      return dialogDirective();
    case 'apierror':
      return 'failure';
    case 'exit': {
      const code = Number.parseInt(rest, 10);
      return leave(Number.isFinite(code) ? code : 0, true);
    }
    case 'crash':
      log({ e: 'crash' });
      process.kill(process.pid, 'SIGKILL');
      return 'abort'; // not reached: SIGKILL ends the process
    case 'say':
      say(rest);
      return 'ok';
    case 'notify': {
      const type = rest.split(/\s+/)[0] ?? '';
      await hook('Notification', { message: rest.slice(type.length).trim(), notification_type: type });
      return 'ok';
    }
    case 'newsession':
      sessionId = randomUUID(); // every later hook carries it, as after /clear
      return 'ok';
    default:
      log({ e: 'directive', name, error: 'unknown directive' });
      say(`fake-claude: unknown directive ${name}`);
      return 'ok';
  }
}

/** Runs the `@fake` lines of a text. Stops at the first outcome other than ok: failure, denied, abort. */
async function runDirectives(text) {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*@fake\s+(\w+)(?:\s+(.*))?$/.exec(line);
    if (match === null) continue;
    count += 1;
    const outcome = await directive(match[1], (match[2] ?? '').trim());
    if (aborted()) return { count, outcome: 'abort' };
    if (outcome !== 'ok') return { count, outcome };
  }
  return { count, outcome: 'ok' };
}

/** What the model does with an instruction: read its mail when it is a pointer, else act on `@fake` lines, else think a moment. */
async function instruct(text) {
  if (!IGNORE_POINTER && POINTER_RE.test(text)) {
    const mail = await mcpTool('read_messages', {});
    if (aborted()) return 'abort';
    let directives = 0;
    for (const message of Array.isArray(mail?.messages) ? mail.messages : []) {
      const run = await runDirectives(String(message?.body ?? ''));
      directives += run.count;
      if (run.outcome !== 'ok') return run.outcome;
    }
    if (directives === 0) await sleepInTurn(TURN_MS);
    return aborted() ? 'abort' : 'ok';
  }
  const run = await runDirectives(text);
  if (run.outcome !== 'ok') return run.outcome;
  if (run.count === 0) await sleepInTurn(TURN_MS);
  return aborted() ? 'abort' : 'ok';
}

async function runTurn(text) {
  turn = { aborted: false, wake: null };
  promptId = randomUUID();
  stopBlocksInRow = 0;
  startWorking();
  say(`> ${text.split('\n')[0]}`);
  await hook('UserPromptSubmit', { prompt: text });
  ensureTranscript();
  let outcome = aborted() ? 'abort' : await instruct(text);
  let stopActive = false;
  while (outcome === 'ok') {
    const reply = await hook('Stop', {
      stop_hook_active: stopActive,
      last_assistant_message: 'ok',
      background_tasks: [],
      session_crons: [],
      effort,
    });
    if (aborted()) {
      outcome = 'abort';
      break;
    }
    if (reply?.decision !== 'block' || typeof reply.reason !== 'string') break;
    if (stopBlocksInRow >= STOP_BLOCK_CAP) {
      log({ e: 'stop-cap', blocks: stopBlocksInRow }); // the 9th consecutive block is ignored and the turn ends
      break;
    }
    stopBlocksInRow += 1;
    stopActive = true;
    outcome = await instruct(reply.reason);
  }
  if (outcome === 'failure') {
    await hook('StopFailure', {
      error: 'server_error',
      error_details: 'fake api error',
      last_assistant_message: 'API Error: fake',
      effort,
    });
  }
  finishTurn();
}

async function runShell(text) {
  turn = { aborted: false, wake: null };
  startWorking();
  say(`> ${text}`);
  await sleepInTurn(SHELL_MS); // a shell command fires no hook at all
  finishTurn();
}

function finishTurn() {
  turn = null;
  stopWorking();
  paintAll();
  const next = queuedPrompts.shift();
  if (next !== undefined) setImmediate(() => submit(next));
}

function submit(text) {
  placeholderLive = false;
  const shell = text.startsWith('!');
  log(shell ? { e: 'prompt', text, shell: true } : { e: 'prompt', text });
  (shell ? runShell(text) : runTurn(text)).catch((error) => {
    log({ e: 'error', message: String(error?.stack ?? error) });
    finishTurn();
  });
}

/* ---- keys (9.4) ---- */

function startupKey(key) {
  if (key === '1' || key === 'y' || key === 'Y' || (key === '\r' && startup.selected === 2)) {
    log({ e: 'dialog', kind: startup.kind, action: 'accepted' });
    startMain();
  } else if (key === '2' || key === 'n' || key === 'N' || key === '\r' || key === ESC || key === '\x03') {
    log({ e: 'dialog', kind: startup.kind, action: 'declined' });
    log({ e: 'exit', code: 1 });
    process.exit(1);
  } else if (key === 'down' || key === 'up') {
    startup.selected = key === 'down' ? 2 : 1;
    paintAll();
  }
}

function dialogKey(key) {
  if (key === '1' || key === '\r') answerDialog('allow');
  else if (key === '2' || key === ESC || key === '\x03') answerDialog('deny');
}

function onEnter() {
  if (IGNORE_CR) return; // a pointer whose Enter was lost
  const text = input.replace(/\s+$/, '');
  if (text.trim() === '') return;
  input = '';
  placeholderLive = false;
  if (turn !== null) {
    queuedPrompts.push(text);
    return;
  }
  submit(text);
}

function onCtrlC() {
  if (turn !== null) {
    interrupt();
  } else if (input !== '') {
    input = '';
    askedCtrlCAt = 0;
  } else if (askedCtrlCAt !== 0 && Date.now() - askedCtrlCAt <= 1000) {
    leave(0, true);
  } else {
    askedCtrlCAt = Date.now();
    showFooter('  Press Ctrl-C again to exit');
  }
}

function onEscape() {
  if (turn !== null) interrupt();
  else input = '';
}

const isPrintable = (character) => {
  const code = character.codePointAt(0);
  return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
};

/** One key or sequence: a character, ESC for the Escape key, `newline` for ESC CR, `up` or `down`. */
function onKey(key) {
  if (startup !== null) return startupKey(key);
  if (dialog !== null) return dialogKey(key);
  if (key === '\r') return onEnter();
  if (key === ESC) return onEscape();
  if (key === '\x03') return onCtrlC();
  if (key === 'up' || key === 'down') return undefined;
  if (key === '\x7f' || key === '\b') input = Array.from(input).slice(0, -1).join('');
  else if (key === '\x15') input = '';
  else if (key === 'newline' || key === '\n') input += '\n';
  else if (isPrintable(key)) input += key;
  else return undefined; // Tab and the other control keys change nothing
  placeholderLive = false;
  return undefined;
}

function onPaste(text) {
  const content = text.replace(/\r\n?/g, '\n');
  log({ e: 'paste', text: content });
  if (startup !== null || dialog !== null) return;
  placeholderLive = false;
  input += content;
}

let pending = '';
let pasting = false;
let pasteText = '';
let escTimer = null;

/** Length of the complete escape sequence at the start of `s`, or 0 while it is unfinished. */
function sequenceLength(s) {
  if (s.length < 2) return 0;
  const next = s[1];
  if (next === '[') {
    let i = 2;
    while (i < s.length && s.charCodeAt(i) >= 0x20 && s.charCodeAt(i) <= 0x3f) i += 1;
    if (i >= s.length) return 0;
    if (s.charCodeAt(i) < 0x40 || s.charCodeAt(i) > 0x7e) return i; // malformed: drop the prefix
    if (i === 2 && s[i] === 'M') return s.length >= 6 ? 6 : 0; // X10 mouse report: three raw bytes follow
    return i + 1;
  }
  if (next === 'O') return s.length >= 3 ? 3 : 0;
  if ('P]_^X'.includes(next)) {
    const bel = s.indexOf(BEL, 2);
    const st = s.indexOf(`${ESC}\\`, 2);
    if (bel === -1 && st === -1) return 0;
    if (st === -1 || (bel !== -1 && bel < st)) return bel + 1;
    return st + 2;
  }
  return 2; // Alt-key, or ESC CR (Shift+Enter): a pair
}

function handleSequence(sequence) {
  if (sequence === PASTE_START) {
    pasting = true;
    pasteText = '';
  } else if (sequence === `${ESC}\r`) onKey('newline');
  else if (sequence === `${ESC}[A`) onKey('up');
  else if (sequence === `${ESC}[B`) onKey('down');
  // focus reports, mouse reports, device replies and the rest are ignored
}

/** The longest suffix of `s` that is a proper prefix of `marker`: the start of a marker that a chunk boundary split. */
function partialMarker(s, marker) {
  for (let n = Math.min(marker.length - 1, s.length); n > 0; n -= 1) {
    if (marker.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

function consume() {
  for (;;) {
    if (pasting) {
      const end = pending.indexOf(PASTE_END);
      if (end === -1) {
        const hold = partialMarker(pending, PASTE_END);
        pasteText += pending.slice(0, pending.length - hold);
        pending = pending.slice(pending.length - hold);
        return;
      }
      pasteText += pending.slice(0, end);
      pending = pending.slice(end + PASTE_END.length);
      pasting = false;
      onPaste(pasteText);
      pasteText = '';
      continue;
    }
    if (pending === '') return;
    if (pending[0] === ESC) {
      const length = sequenceLength(pending);
      if (length === 0) {
        escTimer = setTimeout(() => {
          escTimer = null;
          const lone = pending === ESC;
          pending = '';
          if (lone) onKey(ESC);
          paintBox();
        }, ESC_FLUSH_MS);
        return;
      }
      const sequence = pending.slice(0, length);
      pending = pending.slice(length);
      handleSequence(sequence);
      continue;
    }
    const character = String.fromCodePoint(pending.codePointAt(0));
    pending = pending.slice(character.length);
    onKey(character);
  }
}

function onData(chunk) {
  clearTimeout(escTimer);
  escTimer = null;
  pending += chunk;
  consume();
  paintBox();
}

/* ---- start ---- */

logSize();
write(`${ESC}[?25h`);
setTimeout(() => {
  if (DIALOG === '') startMain();
  else showStartupDialog();
}, READY_MS);
