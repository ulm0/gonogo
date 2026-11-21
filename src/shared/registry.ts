/**
 * The registry (docs/features/registry.md): MCP servers and skills a person can pick from when they write a Payload. Written and checked by hand, shipped
 * in the bundle, read by the page: nothing here is fetched at runtime, and nothing here is ever installed or run by gonogo. A picked server only fills the
 * text of the Payload box, which the person can still edit; what it runs is a command with the agent's own rights, the same as one typed by hand.
 *
 * Every entry was checked against its repository and its package on the date in `checked` (`pnpm registry:check`, by hand: it uses the network, so no test does).
 * npm and PyPI servers are pinned to the version that was checked, because an unpinned `npx` runs whatever was published last; edit the version to move on.
 * No value of a key or a token is ever in an entry: `needs` are NAMES, filled into the server as `${NAME}`, which Claude Code reads from the agent's own
 * environment (Clearance, or the room's keys), so the value stays out of agents.json.
 */
import type { McpServer } from './protocol.js';

interface Base {
  /** A slug: letters, digits and dashes. For an MCP server it is also the name given to the server in the Payload. */
  id: string;
  name: string;
  /** One sentence, at most 140 characters. */
  summary: string;
  /** The licence the repository states (SPDX), or what it says when that is not one. */
  licence: string;
  /** The repository: where the person reads what it does before using it. */
  source: string;
  /** The day it was checked, YYYY-MM-DD. */
  checked: string;
  /** What to know before using it, or null. */
  note: string | null;
}
export interface RegistryServer extends Base {
  kind: 'mcp';
  /** In the shape of a Payload server: this is what is put into the box. */
  server: McpServer;
  /** Names of the environment variables the server reads (or the header names it fills from them): set them in Clearance or the room's keys. */
  needs: string[];
  /** The packaging it needs on the machine (`node`, `uv`), or null for a remote server. */
  runtime: 'node' | 'uv' | null;
  /** What the person edits in the entry before it works (a path, a connection string), or null. */
  edit: string | null;
}
export interface RegistrySkill extends Base {
  kind: 'skill';
  /** The line the person runs themselves, in a terminal, to get the folder. gonogo never runs it. */
  install: string;
  /** The folder with the SKILL.md, relative to the folder that `install` makes. The Payload asks for the absolute path. */
  folder: string;
}
export type RegistryEntry = RegistryServer | RegistrySkill;

const DAY = '2026-11-21';

export const REGISTRY: readonly RegistryEntry[] = [
  {
    kind: 'mcp',
    id: 'filesystem',
    name: 'Filesystem',
    summary: 'Reads and writes files in the folders you name, and nothing outside them.',
    licence: 'Apache-2.0 (MIT for older code)',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    checked: DAY,
    note: 'The folders in args are the only ones it may touch.',
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2.4.0', '/path/to/a/folder'] },
    needs: [],
    runtime: 'node',
    edit: 'Replace /path/to/a/folder with the folder it may use (add more after it).',
  },
  {
    kind: 'mcp',
    id: 'memory',
    name: 'Memory',
    summary: 'A small knowledge graph the agent can write to and read back between sessions.',
    licence: 'Apache-2.0 (MIT for older code)',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    checked: DAY,
    note: null,
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@2.2.1'] },
    needs: [],
    runtime: 'node',
    edit: null,
  },
  {
    kind: 'mcp',
    id: 'sequential-thinking',
    name: 'Sequential thinking',
    summary: 'A tool that lets the agent work through a problem in numbered, revisable steps.',
    licence: 'Apache-2.0 (MIT for older code)',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    checked: DAY,
    note: null,
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking@2.2.0'] },
    needs: [],
    runtime: 'node',
    edit: null,
  },
  {
    kind: 'mcp',
    id: 'fetch',
    name: 'Fetch',
    summary: 'Fetches a web page and gives it to the agent as markdown.',
    licence: 'MIT',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    checked: DAY,
    note: 'It reaches any address the machine can reach, the local network included.',
    server: { command: 'uvx', args: ['mcp-server-fetch==2026.11.18'] },
    needs: [],
    runtime: 'uv',
    edit: null,
  },
  {
    kind: 'mcp',
    id: 'git',
    name: 'Git',
    summary: 'Reads and changes a git repository: status, diff, log, commit, branches.',
    licence: 'MIT',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    checked: DAY,
    note: 'It runs git in the repository you name, so that repository\'s own config and hooks apply.',
    server: { command: 'uvx', args: ['mcp-server-git==2026.11.18', '--repository', '/path/to/a/repository'] },
    needs: [],
    runtime: 'uv',
    edit: 'Replace /path/to/a/repository with the repository it works in.',
  },
  {
    kind: 'mcp',
    id: 'github',
    name: 'GitHub',
    summary: 'GitHub\'s own server: repositories, issues, pull requests, Actions and code search.',
    licence: 'MIT',
    source: 'https://github.com/github/github-mcp-server',
    checked: DAY,
    note: 'A remote server run by GitHub: what the agent asks goes to GitHub. Give the token only the scopes it needs.',
    server: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } },
    needs: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    runtime: null,
    edit: null,
  },
  {
    kind: 'mcp',
    id: 'playwright',
    name: 'Playwright',
    summary: 'Drives a real browser from the page\'s accessibility tree: open, click, type, read.',
    licence: 'Apache-2.0',
    source: 'https://github.com/microsoft/playwright-mcp',
    checked: DAY,
    note: 'It opens a browser on this machine and can reach whatever the browser reaches.',
    server: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.86'] },
    needs: [],
    runtime: 'node',
    edit: null,
  },
  {
    kind: 'mcp',
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    summary: 'Lets the agent debug a live Chrome: console, network, performance, screenshots.',
    licence: 'Apache-2.0',
    source: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    checked: DAY,
    note: 'It controls a Chrome on this machine, and what that browser has open or is signed in to can be read.',
    server: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.13.0'] },
    needs: [],
    runtime: 'node',
    edit: null,
  },
  {
    kind: 'mcp',
    id: 'context7',
    name: 'Context7',
    summary: 'Up-to-date documentation and code examples of libraries, fetched on request.',
    licence: 'MIT',
    source: 'https://github.com/upstash/context7',
    checked: DAY,
    note: 'A remote server run by Upstash: the library names the agent asks about go to it.',
    server: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { Authorization: 'Bearer ${CONTEXT7_API_KEY}' } },
    needs: ['CONTEXT7_API_KEY'],
    runtime: null,
    edit: null,
  },
  {
    kind: 'mcp',
    id: 'notion',
    name: 'Notion',
    summary: 'Reads and writes the pages and databases of a Notion workspace.',
    licence: 'MIT',
    source: 'https://github.com/makenotion/notion-mcp-server',
    checked: DAY,
    note: 'It can reach whatever the integration token was shared with.',
    server: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server@2.6.1'], env: { NOTION_TOKEN: '${NOTION_TOKEN}' } },
    needs: ['NOTION_TOKEN'],
    runtime: 'node',
    edit: null,
  },
  {
    kind: 'mcp',
    id: 'mongodb',
    name: 'MongoDB',
    summary: 'Queries and administers a MongoDB or Atlas deployment.',
    licence: 'Apache-2.0',
    source: 'https://github.com/mongodb-js/mongodb-mcp-server',
    checked: DAY,
    note: 'Whatever the connection string may do, the agent may do. Prefer a read-only user.',
    server: { command: 'npx', args: ['-y', 'mongodb-mcp-server@3.3.0', '--readOnly'], env: { MDB_MCP_CONNECTION_STRING: '${MDB_MCP_CONNECTION_STRING}' } },
    needs: ['MDB_MCP_CONNECTION_STRING'],
    runtime: 'node',
    edit: null,
  },
  ...(['skill-creator', 'mcp-builder', 'webapp-testing', 'frontend-design'] as const).map(
    (id): RegistrySkill => ({
      kind: 'skill',
      id,
      name: id,
      summary: {
        'skill-creator': 'Helps write, test and improve a skill.',
        'mcp-builder': 'A guide for building a good MCP server (Python or TypeScript).',
        'webapp-testing': 'Tests a local web application with Playwright, screenshots and logs included.',
        'frontend-design': 'Guides the visual design of a web interface so it does not look templated.',
      }[id],
      licence: 'Apache-2.0',
      source: `https://github.com/anthropics/skills/tree/main/skills/${id}`,
      checked: DAY,
      note: 'Skills of the same repository have other licences (the document ones are not open): this one is Apache-2.0, by its own LICENSE.txt.',
      install: 'git clone --depth 1 https://github.com/anthropics/skills.git <a folder of your choice>',
      folder: `skills/${id}`,
    }),
  ),
];
