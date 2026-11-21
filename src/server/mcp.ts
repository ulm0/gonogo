import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { LIVERY_DESCRIPTION_MAX_CHARS, LIVERY_NAME_MAX_CHARS } from '../shared/livery.js';
import {
  AGENT_NAME_MAX,
  DIR_MAX_CHARS,
  BOARD_MAX_CHARS,
  LOG_BODY_MAX_CHARS,
  LOG_QUERY_MAX_CHARS,
  LOG_SEARCH_MAX,
  LOG_ANCHOR_FILE_MAX_CHARS,
  LOG_ANCHOR_REPO_MAX_CHARS,
  LOG_ANCHOR_TEXT_MAX_CHARS,
  LOG_ANCHORS_MAX,
  LOG_TAGS_MAX,
  LOG_TITLE_MAX_CHARS,
  MCP_SERVER_NAME,
  POLL_VOTES,
  ROLE_MAX_CHARS,
  TASK_DETAIL_MAX_CHARS,
  MISSION_GOAL_MAX_CHARS,
  REVIEW_BATCH_MAX,
  REVIEW_BODY_MAX_CHARS,
  REVIEW_SIDES,
  REVIEW_TONES,
  MISSION_NAME_MAX_CHARS,
  MISSION_NOTE_MAX_CHARS,
  MISSION_STATUSES,
  TASK_NOTE_MAX_CHARS,
  TASK_STATUSES,
  TASK_TITLE_MAX_CHARS,
} from '../shared/protocol.js';
import type { AgentIdentity, AgentSendRequest, Hub, Logger, Task } from '../shared/protocol.js';
import { FEATURE_TOOLS } from '../shared/features.js';
import { START_AGENT_RATE_MAX, BODY_MAX_CHARS, MAX_MCP_BODY_BYTES, MCP_DESCRIPTIONS, POLL_REASON_MAX_CHARS, READ_MAX_CHARS, SUBJECT_MAX_CHARS } from './constants.js';
import { bearerToken, hubErrorInfo, readBody, sendJson, sendUnauthorized } from './hooks.js';
import type { Board } from './board.js';
import type { Liveries } from './livery.js';
import type { MissionLog } from './missionlog.js';
import type { Relief } from './relief.js';
import type { Tasks } from './tasks.js';
import type { Missions } from './missions.js';
import type { Review } from './review.js';

export interface McpDeps {
  /** Each is called with the generation of the caller's token (contract 3.6, 4.10 rule 7). */
  hub: Pick<Hub, 'sendFromAgent' | 'readMessages' | 'rosterFor' | 'vote' | 'startAgent'>;
  /** The Flight Plan; absent in tests that do not need it (the three task tools then answer that it is not available). */
  tasks?: Pick<Tasks, 'list' | 'create' | 'update'>;
  /** The Mission Log; absent in tests that do not need it (the three log tools then answer that it is not available). */
  /** Missions; absent in tests that do not need it (the three mission tools then answer that it is not available). */
  missions?: Pick<Missions, 'list' | 'create' | 'update'>;
  /** Post-Flight Review; absent in tests that do not need it (the two review tools then answer that it is not available). */
  review?: Pick<Review, 'read' | 'addNotes'>;
  missionLog?: Pick<MissionLog, 'search' | 'get' | 'verify' | 'create' | 'update'>;
  /** The Plot Board; absent in tests that do not need it (the two board tools then answer that it is not available). */
  board?: Pick<Board, 'get' | 'write'>;
  /** Livery; absent in tests that do not need it (the tool then answers that it is not available). */
  liveries?: Pick<Liveries, 'submit'>;
  /** Relief; absent in tests that do not need it (the tool then answers that it is not available). */
  relief?: Pick<Relief, 'request'>;
  /** Feature toggles: is a feature switched off? Its tools are then not listed and a call is refused. Default: nothing is off. */
  featureOff?(id: string): boolean;
  resolveToken(token: string): AgentIdentity | null;
  log: Logger;
  /** Reported to the client in the initialize result; read per request so a late-bound value works. */
  version?: () => string;
}

/** JSON-RPC error codes: parse error, invalid request, "server error" (the SDK's own value for a refused method), internal error. */
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_ALLOWED = -32000;
const RPC_INTERNAL_ERROR = -32603;

function rpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

function toolResult(object: unknown, isError: boolean): CallToolResult {
  const result: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(object) }] };
  if (isError) result.isError = true;
  return result;
}

export function createMcpHandler(deps: McpDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { hub, log } = deps;
  /** When each boss started agents in the last minute (start_agent's rate limit). Memory only. */
  const starts = new Map<string, number[]>();
  const logClose = (e: unknown): void => log.debug('mcp close failed', e);

  /** A HubError tells the agent why; anything else is a bug, logged here and reported without its text. */
  const guarded = async (what: string, run: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await run();
    } catch (e) {
      const info = hubErrorInfo(e);
      if (info) return toolResult({ ok: false, error: info.message }, true);
      log.error(`mcp tool ${what} failed`, e);
      return toolResult({ ok: false, error: 'internal error' }, true);
    }
  };

  // The identity is captured here, from the token: no tool argument can name a sender.
  const buildServer = ({ agent, generation }: AgentIdentity): McpServer => {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: deps.version?.() ?? '0.0.0' });
    // the server object is made for each request, so the list of tools is the one of the features that are on now; a tool that is off is
    // disabled, which leaves it out of tools/list and makes a call of it (an agent that cached the list) an error
    const off = new Set(Object.entries(FEATURE_TOOLS).flatMap(([id, names]) => (deps.featureOff?.(id) === true ? names : [])));
    const register = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => { disable(): void };
    (server as { registerTool: unknown }).registerTool = (name: string, ...rest: unknown[]) => {
      const tool = register(name, ...rest);
      if (off.has(name)) tool.disable();
      return tool;
    };

    server.registerTool(
      'send_message',
      {
        description: MCP_DESCRIPTIONS.send_message,
        inputSchema: {
          to: z.string().min(1).max(64),
          subject: z.string().max(SUBJECT_MAX_CHARS).optional(),
          body: z.string().min(1).max(BODY_MAX_CHARS),
          in_reply_to: z.string().max(40).optional(),
        },
      },
      (args) =>
        guarded('send_message', () => {
          const request: AgentSendRequest = { to: args.to, subject: args.subject ?? '', body: args.body };
          if (args.in_reply_to !== undefined) request.inReplyTo = args.in_reply_to;
          const r = hub.sendFromAgent(agent, generation, request);
          return toolResult({ ok: r.ok, id: r.id, to: r.to, status: r.status, note: r.note }, !r.ok);
        }),
    );

    server.registerTool('list_roster', { description: MCP_DESCRIPTIONS.list_roster }, () =>
      guarded('list_roster', () => toolResult(hub.rosterFor(agent, generation), false)),
    );

    server.registerTool('read_messages', { description: MCP_DESCRIPTIONS.read_messages }, () =>
      guarded('read_messages', () => toolResult(hub.readMessages(agent, generation), false)),
    );

    server.registerTool(
      'go_nogo',
      {
        description: MCP_DESCRIPTIONS.go_nogo,
        inputSchema: { vote: z.enum(POLL_VOTES), reason: z.string().max(POLL_REASON_MAX_CHARS).optional() },
      },
      (args) =>
        guarded('go_nogo', () => {
          const r = hub.vote(agent, generation, args.vote, args.reason ?? '');
          return toolResult({ ok: r.ok, note: r.note }, !r.ok);
        }),
    );

    const { tasks } = deps;
    const noBoard = (): CallToolResult => toolResult({ ok: false, error: 'the Flight Plan is not available' }, true);
    const actor = { kind: 'agent', name: agent, generation } as const;

    server.registerTool(
      'task_list',
      {
        description: MCP_DESCRIPTIONS.task_list,
        inputSchema: { mine: z.boolean().optional(), status: z.enum(TASK_STATUSES).optional() },
      },
      (args) =>
        guarded('task_list', () => {
          if (!tasks) return noBoard();
          const found = tasks
            .list()
            .filter((t) => (args.mine !== true || t.assignee === agent) && (args.status === undefined || t.status === args.status))
            .sort((a, b) => b.updatedAt - a.updatedAt);
          // the same cap as read_messages: Claude Code refuses a tool result of more than 25,000 tokens; the first task always goes
          const shown: Task[] = [];
          let chars = 0;
          for (const t of found) {
            chars += JSON.stringify(t).length;
            if (shown.length > 0 && chars > READ_MAX_CHARS) break;
            shown.push(t);
          }
          return toolResult(found.length === shown.length ? { count: shown.length, tasks: shown } : { count: shown.length, tasks: shown, remaining: found.length - shown.length, note: 'filter by status or mine to see the rest' }, false);
        }),
    );

    server.registerTool(
      'task_create',
      {
        description: MCP_DESCRIPTIONS.task_create,
        inputSchema: { title: z.string().min(1).max(TASK_TITLE_MAX_CHARS), detail: z.string().max(TASK_DETAIL_MAX_CHARS).optional(), assignee: z.string().min(1).max(64).optional(), missionId: z.string().min(1).max(16).optional() },
      },
      (args) => guarded('task_create', async () => (tasks ? toolResult({ ok: true, task: await tasks.create(actor, args) }, false) : noBoard())),
    );

    server.registerTool(
      'task_update',
      {
        description: MCP_DESCRIPTIONS.task_update,
        inputSchema: {
          id: z.string().min(1).max(16),
          status: z.enum(TASK_STATUSES).optional(),
          assignee: z.string().min(1).max(64).nullable().optional(),
          note: z.string().max(TASK_NOTE_MAX_CHARS).optional(),
          missionId: z.string().min(1).max(16).nullable().optional(),
        },
      },
      ({ id, ...patch }) => guarded('task_update', async () => (tasks ? toolResult({ ok: true, task: await tasks.update(actor, id, patch) }, false) : noBoard())),
    );

    const { missions } = deps;
    const noMissions = (): CallToolResult => toolResult({ ok: false, error: 'Missions are not available' }, true);
    const bossOnly = (): CallToolResult => toolResult({ ok: false, error: 'only the boss may change missions' }, true);
    const isBoss = (): boolean => hub.rosterFor(agent, generation).boss === agent;

    server.registerTool(
      'mission_list',
      { description: MCP_DESCRIPTIONS.mission_list, inputSchema: { status: z.enum(MISSION_STATUSES).optional() } },
      (args) =>
        guarded('mission_list', () => {
          if (!missions) return noMissions();
          const found = missions
            .list()
            .filter((m) => args.status === undefined || m.status === args.status)
            .sort((a, b) => b.updatedAt - a.updatedAt);
          const taskList = tasks?.list() ?? [];
          const shown = found.map((m) => {
            const mine = taskList.filter((t) => t.missionId === m.id);
            return { ...m, tasksDone: mine.filter((t) => t.status === 'done').length, tasksTotal: mine.length };
          });
          return toolResult({ count: shown.length, missions: shown }, false);
        }),
    );

    server.registerTool(
      'mission_create',
      {
        description: MCP_DESCRIPTIONS.mission_create,
        inputSchema: { name: z.string().min(1).max(MISSION_NAME_MAX_CHARS), goal: z.string().max(MISSION_GOAL_MAX_CHARS).optional(), lead: z.string().min(1).max(64).optional() },
      },
      (args) =>
        guarded('mission_create', async () => {
          if (!missions) return noMissions();
          if (!isBoss()) return bossOnly();
          return toolResult({ ok: true, mission: await missions.create(actor, args) }, false);
        }),
    );

    server.registerTool(
      'mission_update',
      {
        description: MCP_DESCRIPTIONS.mission_update,
        inputSchema: { id: z.string().min(1).max(16), status: z.enum(MISSION_STATUSES).optional(), note: z.string().max(MISSION_NOTE_MAX_CHARS).optional() },
      },
      ({ id, ...patch }) =>
        guarded('mission_update', async () => {
          if (!missions) return noMissions();
          if (!isBoss()) return bossOnly();
          return toolResult({ ok: true, mission: await missions.update(actor, id, patch) }, false);
        }),
    );

    const { review } = deps;
    const noReview = (): CallToolResult => toolResult({ ok: false, error: 'Post-Flight Review is not available' }, true);
    const asAgent = { kind: 'agent', name: agent } as const;

    server.registerTool(
      'review_read',
      {
        description: MCP_DESCRIPTIONS.review_read,
        inputSchema: { agent: z.string().min(1).max(AGENT_NAME_MAX).optional(), patch: z.boolean().optional(), path: z.string().min(1).max(1000).optional() },
      },
      (args) =>
        guarded('review_read', async () => {
          if (!review) return noReview();
          // the agent is the caller's own when it is left out
          const name = args.agent ?? agent;
          const out = await review.read(name, asAgent, { patch: args.patch === true, path: args.path });
          const view = out.view;
          const files = view.files.map((f) => ({
            path: f.path,
            status: f.status,
            ...(f.oldPath === undefined ? {} : { from: f.oldPath }),
            ...(f.binary ? { binary: true } : {}),
            hunks: f.hunks.map((h) => ({ h: h.header, old: [h.oldStart, h.oldCount], new: [h.newStart, h.newCount] })),
          }));
          return toolResult(
            {
              agent: name,
              repo: view.repo,
              ...(view.reason === undefined ? {} : { reason: view.reason }),
              truncated: view.truncated,
              files,
              notes: view.notes.map((n) => ({ id: n.id, path: n.path, side: n.side, line: n.place.line, place: n.place.state, ...(n.tone === undefined ? {} : { tone: n.tone }), author: n.author, status: n.status, ...(n.replyTo === undefined ? {} : { replyTo: n.replyTo }), text: n.text, body: n.body })),
              verdict: view.verdict === null ? null : { verdict: view.verdict.verdict, at: view.verdict.at, current: !view.stale },
              ...(out.patch === undefined ? {} : { patch: out.patch, ...(out.patchTruncated === true ? { patchTruncated: true } : {}) }),
            },
            false,
          );
        }),
    );

    server.registerTool(
      'review_note',
      {
        description: MCP_DESCRIPTIONS.review_note,
        inputSchema: {
          agent: z.string().min(1).max(AGENT_NAME_MAX).optional(),
          notes: z
            .array(
              z.strictObject({
                path: z.string().max(1000).optional(),
                side: z.enum(REVIEW_SIDES).optional(),
                line: z.number().int().min(1).optional(),
                body: z.string().min(1).max(REVIEW_BODY_MAX_CHARS),
                tone: z.enum(REVIEW_TONES).optional(),
                replyTo: z.string().max(16).optional(),
              }),
            )
            .min(1)
            .max(REVIEW_BATCH_MAX),
        },
      },
      (args) =>
        guarded('review_note', async () => {
          if (!review) return noReview();
          // the author of a note is the caller's own name, never a field of the call; the agent is the caller's own when it is left out
          const added = await review.addNotes(asAgent, args.agent ?? agent, args.notes);
          return toolResult({ ok: true, added: added.map((n) => n.id) }, false);
        }),
    );

    const { missionLog } = deps;
    const noLog = (): CallToolResult => toolResult({ ok: false, error: 'the Mission Log is not available' }, true);

    server.registerTool(
      'log_write',
      {
        description: MCP_DESCRIPTIONS.log_write,
        inputSchema: {
          id: z.string().min(1).max(16).optional(),
          title: z.string().min(1).max(LOG_TITLE_MAX_CHARS).optional(),
          body: z.string().min(1).max(LOG_BODY_MAX_CHARS).optional(),
          tags: z.array(z.string().min(1).max(64)).max(LOG_TAGS_MAX).optional(),
          anchors: z.array(z.object({ repo: z.string().min(1).max(LOG_ANCHOR_REPO_MAX_CHARS), file: z.string().min(1).max(LOG_ANCHOR_FILE_MAX_CHARS), kind: z.enum(['present', 'absent']), text: z.string().min(1).max(LOG_ANCHOR_TEXT_MAX_CHARS) }).strict()).max(LOG_ANCHORS_MAX).optional(),
        },
      },
      ({ id, ...fields }) =>
        guarded('log_write', async () => {
          if (!missionLog) return noLog();
          // the author is the caller's own name, never a field of the call
          const entry = await (id === undefined ? missionLog.create(agent, fields) : missionLog.update(id, fields, agent));
          return toolResult({ ok: true, id: entry.id, title: entry.title, tags: entry.tags }, false);
        }),
    );

    server.registerTool(
      'log_search',
      {
        description: MCP_DESCRIPTIONS.log_search,
        inputSchema: { query: z.string().min(1).max(LOG_QUERY_MAX_CHARS), limit: z.number().int().min(1).max(LOG_SEARCH_MAX).optional() },
      },
      ({ query, limit }) =>
        guarded('log_search', () => {
          if (!missionLog) return noLog();
          const { hits } = missionLog.search(query, limit ?? LOG_SEARCH_MAX);
          return toolResult({ count: hits.length, results: hits }, false);
        }),
    );

    server.registerTool('log_read', { description: MCP_DESCRIPTIONS.log_read, inputSchema: { id: z.string().min(1).max(16) } }, ({ id }) =>
      guarded('log_read', async () => {
        if (!missionLog) return noLog();
        await missionLog.verify(id);
        return toolResult({ ok: true, entry: missionLog.get(id) }, false);
      }),
    );

    const { board } = deps;
    const noPlot = (): CallToolResult => toolResult({ ok: false, error: 'the Plot Board is not available' }, true);
    // the boss is the one the hub says it is, asked at each call: a rename or a new boss takes effect at once
    const bossName = (): string | null => hub.rosterFor(agent, generation).boss;

    server.registerTool('board_read', { description: MCP_DESCRIPTIONS.board_read }, () =>
      guarded('board_read', () => (board ? toolResult({ ok: true, ...board.get(), canWrite: bossName() === agent }, false) : noPlot())),
    );

    server.registerTool(
      'board_write',
      { description: MCP_DESCRIPTIONS.board_write, inputSchema: { text: z.string().max(BOARD_MAX_CHARS), revision: z.number().int().min(0) } },
      (args) =>
        guarded('board_write', async () => {
          if (!board) return noPlot();
          if (bossName() !== agent) return toolResult({ ok: false, error: 'only the boss may write the Plot Board' }, true);
          // the author is the caller's own name, never a field of the call
          const view = await board.write(agent, args);
          return toolResult({ ok: true, revision: view.revision, updatedAt: view.updatedAt }, false);
        }),
    );

    const { liveries } = deps;
    server.registerTool(
      'livery_submit',
      {
        description: MCP_DESCRIPTIONS.livery_submit,
        inputSchema: { name: z.string().min(1).max(LIVERY_NAME_MAX_CHARS), description: z.string().max(LIVERY_DESCRIPTION_MAX_CHARS).optional(), tokens: z.record(z.string().max(64), z.string().max(64)) },
      },
      (args) =>
        guarded('livery_submit', async () => {
          if (!liveries) return toolResult({ ok: false, error: 'Livery is not available' }, true);
          // the author is the caller's own name, never a field of the call
          const entry = await liveries.submit(agent, args);
          return toolResult({ ok: true, slug: entry.slug, note: 'saved; the Director chooses whether to apply it' }, false);
        }),
    );

    const { relief } = deps;
    server.registerTool(
      'start_agent',
      { description: MCP_DESCRIPTIONS.start_agent, inputSchema: z.strictObject({ name: z.string().min(1).max(AGENT_NAME_MAX) }) },
      ({ name }) =>
        guarded('start_agent', async () => {
          if (!isBoss()) return toolResult({ ok: false, error: 'only the boss may start an agent' }, true);
          const at = Date.now();
          const mine = (starts.get(agent) ?? []).filter((t) => at - t < 60_000);
          if (mine.length >= START_AGENT_RATE_MAX) return toolResult({ ok: false, error: `at most ${START_AGENT_RATE_MAX} starts a minute` }, true);
          // the caller is the agent of the token, never a field of the call; the hub refuses a running agent and one on hold
          // counted before the await: parallel calls must not all pass the limit
          starts.set(agent, [...mine, at]);
          const view = await hub.startAgent(name, agent);
          return toolResult({ ok: true, name: view.name, state: view.state }, false);
        }),
    );
    server.registerTool(
      'hire_agent',
      {
        description: MCP_DESCRIPTIONS.hire_agent,
        // strict: a field the tool does not have (confirmBypass, command, payload) is refused, not dropped; the mode is checked by Relief, so that its answer says why
        inputSchema: z.strictObject({
          name: z.string().min(1).max(AGENT_NAME_MAX),
          position: z.string().max(32).optional(),
          role: z.string().max(ROLE_MAX_CHARS).optional(),
          dir: z.string().max(DIR_MAX_CHARS).optional(),
          engine: z.string().max(32).optional(),
          mode: z.string().max(32).optional(),
        }),
      },
      (args) =>
        guarded('hire_agent', async () => {
          if (!relief) return toolResult({ ok: false, error: 'Relief is not available' }, true);
          // the requester is the agent of the token, never a field of the call
          return toolResult({ ok: true, ...(await relief.request({ agent, generation }, args)) }, false);
        }),
    );

    return server;
  };

  return async (req, res) => {
    const token = bearerToken(req.headers.authorization);
    const identity = token === null ? null : deps.resolveToken(token);
    if (!identity) {
      sendUnauthorized(res);
      return;
    }
    // stateless: there is no session to resume (GET) or end (DELETE); claude opens one GET, gets this, and carries on
    if (req.method !== 'POST') {
      sendJson(res, 405, rpcError(RPC_METHOD_NOT_ALLOWED, 'Method not allowed.'), { Allow: 'POST' });
      return;
    }

    try {
      const body = await readBody(req, MAX_MCP_BODY_BYTES);
      if (!body.ok) {
        if (body.reason === 'too_large') sendJson(res, 413, rpcError(RPC_INVALID_REQUEST, 'Request body too large.'));
        else res.destroy();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.body.toString('utf8'));
      } catch {
        sendJson(res, 400, rpcError(RPC_PARSE_ERROR, 'Parse error: the body is not valid JSON.'));
        return;
      }

      // The SDK writes its own Cache-Control for the event stream, over the one set here; contract 3.2 wants no-store on every MCP answer.
      res.setHeader('Cache-Control', 'no-store');
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => (name.toLowerCase() === 'cache-control' ? res : setHeader(name, value));

      const server = buildServer(identity);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const closeBoth = (): void => {
        void transport.close().catch(logClose);
        void server.close().catch(logClose);
      };
      if (res.destroyed) closeBoth();
      else res.on('close', closeBoth);
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (e) {
      log.error('mcp request failed', e);
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, rpcError(RPC_INTERNAL_ERROR, 'Internal error.'));
    }
  };
}
