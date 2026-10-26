import { createServer as createHttpServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';

import { Storage } from '../../../packages/storage-sqlite/src/index.ts';
import type { LlmProvider } from '../../../packages/llm-gateway/src/index.ts';
import type { ToolRegistry } from '../../../packages/tools/src/index.ts';
import type { RandomSource } from '../../../packages/rules-core/src/index.ts';
import { createEntropyRandom } from '../../../packages/rules-core/src/index.ts';
import type { SceneLike } from '../../../packages/turn-pipeline/src/index.ts';
import { createRequestHandler } from './http.ts';
import { Room, type Seat } from './room.ts';
import { handleClientMessage } from './ws.ts';

export interface ServerOptions {
  dbPath: string;
  provider: LlmProvider;
  tools: ToolRegistry;
  random?: RandomSource;
  /** 场景与角色的数据源；桌面模式下由模组加载器提供。 */
  sceneOf?: (sceneId: string) => SceneLike | undefined;
  charactersOf?: () => Record<string, { name: string; skills: Record<string, number> }>;
  /** 允许的来源；默认只放行回环（`http://127.0.0.1:*` 与 `http://localhost:*`）。 */
  allowedOrigins?: (origin: string | undefined) => boolean;
}

export interface RunningServer {
  server: Server;
  storage: Storage;
  rooms: Map<string, Room>;
  port: number;
  close: () => Promise<void>;
}

const DEFAULT_ALLOWED = (origin: string | undefined): boolean => {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
};

export async function createServer(options: ServerOptions): Promise<RunningServer> {
  const storage = Storage.open({ path: options.dbPath });
  const random = options.random ?? createEntropyRandom();
  const rooms = new Map<string, Room>();

  const handlers = createRequestHandler({
    storage,
    rooms,
    allowedOrigins: options.allowedOrigins ?? DEFAULT_ALLOWED,
  });

  const httpServer = createHttpServer((request, response) => {
    void handlers(request, response);
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const defaultSeat = (sessionId: string): Seat => ({
    seatId: `seat_p1_${sessionId.slice(-4)}`,
    role: 'player',
    actorIds: [],
    factions: [],
  });

  const ensureRoom = (sessionId: string): Room | undefined => {
    const existing = rooms.get(sessionId);
    if (existing !== undefined) return existing;
    const session = storage.getSession(sessionId);
    if (session === null) return undefined;
    const room = new Room({
      sessionId,
      storage,
      provider: options.provider,
      tools: options.tools,
      random,
      sceneOf: options.sceneOf,
      charactersOf: options.charactersOf,
    });
    rooms.set(sessionId, room);
    return room;
  };

  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      handleClientMessage(socket, data.toString(), { rooms, ensureRoom, defaultSeat });
    });
    socket.on('close', () => {
      for (const room of rooms.values()) room.leave(socket);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });

  return {
    server: httpServer,
    storage,
    rooms,
    port,
    async close() {
      for (const room of rooms.values()) room.close();
      rooms.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      // ws 的连接已随 room.close() 关掉；这里兜底强制断开，否则 server.close() 会一直等
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      storage.close();
    },
  };
}
