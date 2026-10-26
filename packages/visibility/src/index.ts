/**
 * 可见性代数（DESIGN.md §8.2）。
 *
 * 唯一判定入口：所有「谁能看到什么」都走 `canSee`，不要在各处写
 * `if (event.private)`。规则只有一处，才谈得上审得清。
 */
export type Visibility =
  | { kind: 'public' }
  /** 只有主持人（人类或 AI）可见 */
  | { kind: 'gm_only' }
  /** 指定席位可见，座位表在会话内固定 */
  | { kind: 'seats'; seats: readonly string[] }
  /** 角色卡的持有者可见 */
  | { kind: 'actor_owner'; actorId: string }
  /** 同一阵营可见（如邪教徒之间） */
  | { kind: 'faction'; faction: string }
  /** 全局序号推进到这个值之后才可见（延迟揭示） */
  | { kind: 'after'; seq: number }
  /** 永不外发：只存在于服务端，连 GM 界面也不渲染 */
  | { kind: 'never' };

export interface Viewer {
  seatId: string;
  role: 'gm' | 'player' | 'spectator';
  /** 该席位控制的角色 */
  actorIds: readonly string[];
  /** 该席位所属阵营 */
  factions: readonly string[];
  /** 该客户端已经收到的最大 seq；用于 `after` 判定 */
  seq: number;
}

export const PUBLIC: Visibility = { kind: 'public' };
export const GM_ONLY: Visibility = { kind: 'gm_only' };
export const NEVER: Visibility = { kind: 'never' };

export function seats(...seatIds: string[]): Visibility {
  return { kind: 'seats', seats: seatIds };
}

export function actorOwner(actorId: string): Visibility {
  return { kind: 'actor_owner', actorId };
}

export function faction(name: string): Visibility {
  return { kind: 'faction', faction: name };
}

export function after(seq: number): Visibility {
  return { kind: 'after', seq };
}

/**
 * 这个观察者能不能看到这条内容。
 *
 * 主持人是唯一能看到全部（`never` 除外）的角色——这不只是特权，
 * 也是他能在玩家之间转述的前提。
 */
export function canSee(viewer: Viewer, visibility: Visibility, currentSeq?: number): boolean {
  switch (visibility.kind) {
    case 'public':
      return true;
    case 'never':
      return false;
    case 'gm_only':
      return viewer.role === 'gm';
    case 'seats':
      return viewer.seatId !== '' && visibility.seats.includes(viewer.seatId);
    case 'actor_owner':
      return viewer.actorIds.includes(visibility.actorId);
    case 'faction':
      return viewer.factions.includes(visibility.faction);
    case 'after':
      return (currentSeq ?? viewer.seq) > visibility.seq;
    default: {
      const exhaustive: never = visibility;
      throw new Error(`未知的可见性：${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 先看可见性，再看是不是 GM 专属；两者合并成一个判断，避免调用方漏判。 */
export function visibleTo(viewer: Viewer, visibility: Visibility, currentSeq?: number): boolean {
  if (viewer.role === 'gm' && visibility.kind !== 'never') return true;
  return canSee(viewer, visibility, currentSeq);
}

export interface Runnable {
  id: string;
  seq: number;
  visibility: Visibility;
}

/**
 * 把一串事件裁成这个观察者能看到的那些。
 * 保留原顺序（seq 升序），因为叙事是连续的。
 */
export function redact<T extends Runnable>(items: readonly T[], viewer: Viewer): T[] {
  return items.filter((item) => visibleTo(viewer, item.visibility, viewer.seq));
}

/**
 * 同一批里给不同人看不同内容（§8.3 的 `privates[]`）。
 * 返回 `Map<seatId, T[]>`，没有私有内容的席位不出现在结果里。
 */
export function splitBySeat<T extends { audience: readonly string[] }>(
  items: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    for (const seatId of item.audience) {
      const list = out.get(seatId);
      if (list === undefined) out.set(seatId, [item]);
      else list.push(item);
    }
  }
  return out;
}
