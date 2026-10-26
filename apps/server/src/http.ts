import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Storage } from '../../../packages/storage-sqlite/src/index.ts';
import type { Room } from './room.ts';
import { visibleTo, type Viewer, type Visibility } from '../../../packages/visibility/src/index.ts';

export interface AppDeps {
  storage: Storage;
  rooms: Map<string, Room>;
  /** 桌面模式下只绑回环，任何跨源请求都拒绝（§14.4）。 */
  allowedOrigins?: (origin: string | undefined) => boolean;
}

interface RouteMatch {
  params: Record<string, string>;
}

const ROUTES: Array<{ method: string; pattern: RegExp; keys: string[] }> = [
  { method: 'POST', pattern: /^\/api\/sessions$/, keys: [] },
  { method: 'GET', pattern: /^\/api\/sessions$/, keys: [] },
  { method: 'GET', pattern: /^\/api\/sessions\/([^/]+)$/, keys: ['id'] },
  { method: 'GET', pattern: /^\/api\/sessions\/([^/]+)\/events$/, keys: ['id'] },
  { method: 'GET', pattern: /^\/api\/sessions\/([^/]+)\/search$/, keys: ['id'] },
  { method: 'GET', pattern: /^\/api\/health$/, keys: [] },
];

function matchRoute(method: string, pathname: string): RouteMatch | undefined {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const matched = route.pattern.exec(pathname);
    if (matched === null) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(matched[index + 1] ?? '');
    });
    return { params };
  }
  return undefined;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function viewerOf(seatId: string | null, room: Room | undefined): Viewer {
  const seat = seatId !== null && room !== undefined ? room.seat(seatId) : undefined;
  return {
    seatId: seatId ?? 'anon',
    role: seat?.role ?? 'spectator',
    actorIds: seat?.actorIds ?? [],
    factions: seat?.factions ?? [],
    seq: 0,
  };
}

/** 把事件 payload 摊平成可搜索文本；只从叙述类事件取，避免把状态补丁也搜出来。 */
const SEARCHABLE_TYPES = new Set(['narration.final', 'narration.private', 'gm.note', 'turn.batch_frozen']);

function textOf(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const record = payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['public', 'text', 'content']) {
    const value = record[key];
    if (typeof value === 'string') parts.push(value);
  }
  const inputs = record['inputs'];
  if (Array.isArray(inputs)) {
    for (const input of inputs) {
      if (typeof input === 'object' && input !== null && typeof (input as { text?: unknown }).text === 'string') {
        parts.push((input as { text: string }).text);
      }
    }
  }
  return parts.join('\n');
}

export function createRequestHandler(deps: AppDeps) {
  const allowOrigin = deps.allowedOrigins ?? (() => true);

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const origin = request.headers.origin;

    // 回环 + Origin 校验：桌面模式下渲染进程与内嵌服务同源，跨源的一律拒绝（§5.5）
    if (origin !== undefined && !allowOrigin(origin)) {
      json(response, 403, { error: 'origin_not_allowed' });
      return;
    }
    if (origin !== undefined) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'origin');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      response.end();
      return;
    }

    const matched = matchRoute(request.method ?? 'GET', url.pathname);
    if (matched === undefined) {
      json(response, 404, { error: 'not_found', path: url.pathname });
      return;
    }

    try {
      if (url.pathname === '/api/health') {
        json(response, 200, { ok: true, sessions: deps.rooms.size });
        return;
      }

      if (url.pathname === '/api/sessions') {
        if (request.method === 'POST') {
          const body = await readJson(request);
          const title = typeof body['title'] === 'string' ? body['title'] : '未命名的一局';
          const rulesetId = typeof body['rulesetId'] === 'string' ? body['rulesetId'] : 'coc7e';
          const session = await deps.storage.createSession({ id: `s_${Date.now().toString(36)}`, rulesetId, title });
          json(response, 201, session);
          return;
        }
        json(response, 200, { sessions: deps.storage.listSessions() });
        return;
      }

      const sessionId = matched.params['id'] ?? '';

      if (url.pathname.endsWith('/events')) {
        const session = deps.storage.getSession(sessionId);
        if (session === null) {
          json(response, 404, { error: 'session_not_found' });
          return;
        }
        const room = deps.rooms.get(sessionId);
        const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0');
        const seatId = url.searchParams.get('seatId');
        const viewer = viewerOf(seatId, room);
        const events = deps.storage.readEvents({
          sessionId,
          afterSeq: Number.isFinite(afterSeq) ? afterSeq : 0,
          limit: Number(url.searchParams.get('limit') ?? '500'),
        });
        const visible = events
          .filter((event) => visibleTo(viewer, event.visibility as Visibility))
          .map((event) => ({ seq: event.seq, type: event.type, payload: event.payload, createdAt: event.createdAt }));
        json(response, 200, { sessionId, events: visible });
        return;
      }

      if (url.pathname.endsWith('/search')) {
        const session = deps.storage.getSession(sessionId);
        if (session === null) {
          json(response, 404, { error: 'session_not_found' });
          return;
        }
        const room = deps.rooms.get(sessionId);
        const viewer = viewerOf(url.searchParams.get('seatId'), room);
        const query = (url.searchParams.get('q') ?? '').trim();
        if (query === '') {
          json(response, 200, { sessionId, query, hits: [] });
          return;
        }
        const needle = query.toLowerCase();
        const events = deps.storage.readEvents({ sessionId, limit: 5000, descending: true });
        const hits: Array<{ seq: number; type: string; text: string }> = [];
        for (const event of events) {
          if (!SEARCHABLE_TYPES.has(event.type)) continue;
          if (!visibleTo(viewer, event.visibility as Visibility)) continue;
          const text = textOf(event.payload);
          if (text === '' || !text.toLowerCase().includes(needle)) continue;
          hits.push({ seq: event.seq, type: event.type, text: text.slice(0, 240) });
          if (hits.length >= 50) break;
        }
        json(response, 200, { sessionId, query, hits });
        return;
      }

      // GET /api/sessions/:id
      const session = deps.storage.getSession(sessionId);
      if (session === null) {
        json(response, 404, { error: 'session_not_found' });
        return;
      }
      json(response, 200, { ...session, lastSeq: deps.storage.lastSeq(sessionId) });
    } catch (error) {
      json(response, 400, { error: 'bad_request', message: error instanceof Error ? error.message : String(error) });
    }
  };
}
