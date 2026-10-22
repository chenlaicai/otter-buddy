/**
 * 牌局落帧（sqlite）——每步动作一帧：帧号 + 触发动作 + 全量状态快照 + 哈希链。
 *
 * - 哈希链：hash = sha256(prev_hash \n seq \n action_json \n state_json)（基于库内存储串计算，
 *   JSON 序列化往返稳定 → 恢复/复盘重算一致，链断即可侦篡改）
 * - 恢复：latestFrame → 全量 state 直接还原引擎（断线重连/进程重启）
 * - 复盘：frames 按 seq 升序回放
 *
 * 表结构见 frameworks/db/schema.ts createMahjongTables（#506 幂等补建）。
 */

import { createHash } from "crypto";
import type Database from "better-sqlite3";
import type { EngineAction, GameState } from "../engine/types";

interface GameRow {
  id: string;
  room_id: string;
  seed: string;
  status: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

interface FrameRow {
  game_id: string;
  seq: number;
  action_json: string | null;
  state_json: string;
  prev_hash: string | null;
  hash: string;
  created_at: string;
}

export interface GameRecord {
  id: string;
  roomId: string;
  seed: string;
  status: string;
  config: GameState["config"];
  createdAt: string;
  updatedAt: string;
}

export interface FrameRecord {
  seq: number;
  action: EngineAction | null;
  state: GameState;
  prevHash: string | null;
  hash: string;
  createdAt: string;
}

function computeHash(prevHash: string | null, seq: number, actionJson: string | null, stateJson: string): string {
  return createHash("sha256").update(`${prevHash ?? ""}\n${seq}\n${actionJson ?? ""}\n${stateJson}`).digest("hex");
}

function toGameRecord(r: GameRow): GameRecord {
  return {
    id: r.id,
    roomId: r.room_id,
    seed: r.seed,
    status: r.status,
    config: JSON.parse(r.config_json) as GameState["config"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toFrameRecord(r: FrameRow): FrameRecord {
  return {
    seq: r.seq,
    action: r.action_json ? (JSON.parse(r.action_json) as EngineAction) : null,
    state: JSON.parse(r.state_json) as GameState,
    prevHash: r.prev_hash,
    hash: r.hash,
    createdAt: r.created_at,
  };
}

export class SqliteFrameStore {
  constructor(private readonly db: Database.Database) {}

  // ── 比赛元数据 ──

  /** F20261022mjls：status 可选（默认 playing 兼容旧调用）；waiting = lobby 等待房 */
  createGame(id: string, roomId: string, config: GameState["config"], status = "playing"): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO mahjong_games (id, room_id, seed, status, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, roomId, config.seed, status, JSON.stringify(config), now, now);
  }

  getGame(id: string): GameRecord | null {
    const row = this.db.prepare("SELECT * FROM mahjong_games WHERE id = ?").get(id) as GameRow | undefined;
    return row ? toGameRecord(row) : null;
  }

  findGameByRoom(roomId: string): GameRecord | null {
    const row = this.db
      .prepare("SELECT * FROM mahjong_games WHERE room_id = ? AND status = 'playing' ORDER BY created_at DESC LIMIT 1")
      .get(roomId) as GameRow | undefined;
    if (row) return toGameRecord(row);
    const any = this.db
      .prepare("SELECT * FROM mahjong_games WHERE room_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(roomId) as GameRow | undefined;
    return any ? toGameRecord(any) : null;
  }

  updateGameStatus(id: string, status: string): void {
    this.db
      .prepare("UPDATE mahjong_games SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  /** F20261022mjls：lobby 开始时回写座位配置（默认獭回填/自定义覆盖后的最终 players）——恢复/review 用真相源 */
  updateGameConfig(id: string, config: GameState["config"]): void {
    this.db
      .prepare("UPDATE mahjong_games SET config_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(config), new Date().toISOString(), id);
  }

  // ── 帧 ──

  /** 追加一帧（state = 动作落地后的全量快照）；返回入帧记录 */
  appendFrame(gameId: string, state: GameState, action: EngineAction | null): FrameRecord {
    const latest = this.latestFrame(gameId);
    const seq = latest ? latest.seq + 1 : 0;
    const stateJson = JSON.stringify(state);
    const actionJson = action ? JSON.stringify(action) : null;
    const prevHash = latest ? latest.hash : null;
    const hash = computeHash(prevHash, seq, actionJson, stateJson);
    this.db
      .prepare(
        "INSERT INTO mahjong_frames (game_id, seq, action_json, state_json, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(gameId, seq, actionJson, stateJson, prevHash, hash, new Date().toISOString());
    const record: FrameRecord = {
      seq,
      action: action ? (JSON.parse(actionJson!) as EngineAction) : null,
      state,
      prevHash,
      hash,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("UPDATE mahjong_games SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), gameId);
    return record;
  }

  latestFrame(gameId: string): FrameRecord | null {
    const row = this.db
      .prepare("SELECT * FROM mahjong_frames WHERE game_id = ? ORDER BY seq DESC LIMIT 1")
      .get(gameId) as FrameRow | undefined;
    return row ? toFrameRecord(row) : null;
  }

  listFrames(gameId: string): FrameRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM mahjong_frames WHERE game_id = ? ORDER BY seq ASC")
      .all(gameId) as FrameRow[];
    return rows.map(toFrameRecord);
  }

  /** 哈希链完整性校验：seq 连续 + 每帧重算 hash 一致；返回首错帧号（无错 = null） */
  verifyChain(gameId: string): number | null {
    const rows = this.db
      .prepare("SELECT * FROM mahjong_frames WHERE game_id = ? ORDER BY seq ASC")
      .all(gameId) as FrameRow[];
    let prev: string | null = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.seq !== i) return r.seq;
      if (r.prev_hash !== prev) return r.seq;
      if (computeHash(r.prev_hash, r.seq, r.action_json, r.state_json) !== r.hash) return r.seq;
      prev = r.hash;
    }
    return null;
  }
}
