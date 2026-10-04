import { Chess, type Square } from 'chess.js';
import type { GameRecord, GameStatus } from './types';

/**
 * Pure chess-state helpers shared by the live game room and the test suite.
 *
 * The relay is not an authoritative server: every browser keeps its own copy of
 * the game snapshot and exchanges whole snapshots with the opponent. That means a
 * snapshot can arrive that is behind the board it carries (for example a client
 * that exchanged the mating move but never marked the game finished). Everything
 * in this module derives the truth from the FEN so both players agree on the
 * final result even when a snapshot or its status is stale.
 */

export type PositionVerdict = {
  status: Extract<GameStatus, 'checkmate' | 'stalemate' | 'draw'>;
  result_reason: string;
  winner_color: 'w' | 'b' | null;
};

export type MateInfo = { king: string; attackers: string[]; arrows: Array<{ from: string; to: string; color: string }> };

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

/** Reads the terminal verdict of a position, or null while play continues. */
export function positionVerdict(fen: string): PositionVerdict | null {
  try {
    const chess = new Chess(fen);
    if (chess.isCheckmate()) {
      // The side to move is the one that cannot escape, so the opponent delivered mate.
      return { status: 'checkmate', result_reason: 'checkmate', winner_color: chess.turn() === 'w' ? 'b' : 'w' };
    }
    if (chess.isStalemate()) return { status: 'stalemate', result_reason: 'stalemate', winner_color: null };
    if (chess.isInsufficientMaterial()) return { status: 'draw', result_reason: 'insufficient_material', winner_color: null };
    if (chess.isThreefoldRepetition()) return { status: 'draw', result_reason: 'threefold_repetition', winner_color: null };
    if (chess.isDrawByFiftyMoves()) return { status: 'draw', result_reason: 'fifty_move', winner_color: null };
    return null;
  } catch {
    return null;
  }
}

export function winnerIdFor(game: Pick<GameRecord, 'white_id' | 'black_id'>, verdict: PositionVerdict) {
  if (verdict.winner_color === 'w') return game.white_id;
  if (verdict.winner_color === 'b') return game.black_id;
  return null;
}

export type ReconcileResult<T extends GameRecord> = { game: T; corrected: boolean };

/**
 * Fills in a terminal status, winner and result reason from the board whenever a
 * snapshot still claims the game is running (or claims the wrong terminal state).
 * A terminal snapshot is never demoted back to active: resignation, timeout and
 * agreed draws stay authoritative because they cannot be read from a FEN.
 */
export function reconcileGameSnapshot<T extends GameRecord>(game: T, now = new Date().toISOString()): ReconcileResult<T> {
  const verdict = positionVerdict(game.fen);
  if (!verdict) return { game, corrected: false };

  const whiteId = game.white_id;
  const blackId = game.black_id;
  const expectedWinner = verdict.winner_color === 'w' ? whiteId : verdict.winner_color === 'b' ? blackId : null;
  const isPositionTerminal = game.status === 'checkmate' || game.status === 'stalemate' || game.status === 'draw';

  if (isPositionTerminal) {
    const statusMatches = game.status === verdict.status;
    const winnerMatches = (game.winner_id ?? null) === expectedWinner;
    const reasonMatches = Boolean(game.result_reason);
    if (statusMatches && winnerMatches && reasonMatches) return { game, corrected: false };
  }

  return {
    game: {
      ...game,
      status: verdict.status,
      winner_id: expectedWinner,
      result_reason: verdict.result_reason,
      turn_user_id: null,
      turn_started_at: null,
      finished_at: game.finished_at || now,
      version: game.version + 1,
      updated_at: now,
    },
    corrected: true,
  };
}

export type SnapshotDecision = {
  accepted: boolean;
  /** Snapshot the client should keep (unchanged when the update was rejected). */
  game: GameRecord;
  /** True when the peer should receive the corrected snapshot back. */
  rebroadcast: boolean;
  reason: 'applied' | 'applied-final-result' | 'ignored-stale' | 'ignored-other-game';
};

/**
 * Decides whether an incoming snapshot should replace the local one.
 *
 * Normal updates must be strictly newer. The important exception is a final
 * result that arrives with a version collision (both clients bumped their own
 * version while trading events): when the incoming board itself is provably
 * terminal and is not behind on moves, it wins over a locally "active" game so
 * both players still see the same checkmate. The corrected snapshot is then
 * rebroadcast so the other side converges too.
 */
export function decideIncomingSnapshot(current: GameRecord, incoming: GameRecord, now = new Date().toISOString()): SnapshotDecision {
  if (current.id !== incoming.id) return { accepted: false, game: current, rebroadcast: false, reason: 'ignored-other-game' };

  const { game: reconciled, corrected } = reconcileGameSnapshot(incoming, now);

  // A finished game is never revived by a lagging snapshot: there is no path back
  // to "active" inside one game id (a rematch gets a new id). A strictly newer
  // final result still wins, so a race between two endings resolves the same way
  // on both clients.
  const localStillPlaying = current.status === 'active' || current.status === 'pending';
  if (!localStillPlaying) {
    const incomingIsFinal = reconciled.status !== 'active' && reconciled.status !== 'pending';
    if (!incomingIsFinal || reconciled.version <= current.version) return { accepted: false, game: current, rebroadcast: false, reason: 'ignored-stale' };
  }

  if (reconciled.version > current.version) {
    return { accepted: true, game: reconciled, rebroadcast: corrected, reason: corrected ? 'applied-final-result' : 'applied' };
  }

  const incomingCall = positionVerdict(reconciled.fen);
  const incomingIsFinal = Boolean(incomingCall) && reconciled.status !== 'active' && reconciled.status !== 'pending';
  const notBehind = reconciled.moves_count >= current.moves_count;

  if (incomingIsFinal && localStillPlaying && notBehind) {
    const advanced = { ...reconciled, version: Math.max(current.version, reconciled.version) + 1, updated_at: now };
    return { accepted: true, game: advanced, rebroadcast: true, reason: 'applied-final-result' };
  }

  return { accepted: false, game: current, rebroadcast: false, reason: 'ignored-stale' };
}

export type RelayApplication = {
  accepted: boolean;
  /** Snapshot the client should store (unchanged when the update was rejected). */
  game: GameRecord;
  /** True when the corrected snapshot should be echoed back to the sender. */
  rebroadcast: boolean;
  /** True when an unfinished local game just received its final result. */
  finished: boolean;
  /** True when the position advanced, so a move sound is appropriate. */
  sound: boolean;
};

/**
 * Applies a snapshot relayed by the opponent. This is the whole cross-player
 * contract: only the two players may update a game, only newer snapshots (or a
 * provable final result) replace the local copy, and a snapshot that disagrees
 * with its own board is corrected instead of being trusted.
 */
export function applyRelayedSnapshot(
  current: GameRecord,
  incoming: GameRecord,
  options: { fromId: string; localPlayerId: string; now?: string },
): RelayApplication {
  const noop = { accepted: false, game: current, rebroadcast: false, finished: false, sound: false } as const;
  if (!options.fromId || options.fromId === options.localPlayerId) return noop;
  if (![current.white_id, current.black_id].includes(options.fromId)) return noop;

  const decision = decideIncomingSnapshot(current, incoming, options.now);
  if (!decision.accepted) return noop;

  return {
    accepted: true,
    game: decision.game,
    rebroadcast: decision.rebroadcast,
    finished: current.status === 'active' && decision.game.status !== 'active',
    sound: decision.game.moves_count > current.moves_count,
  };
}

/** Derives checkmate marks and arrows from the position instead of trusting stored flags. */
export function mateInfoFromFen(fen: string): MateInfo | null {
  const verdict = positionVerdict(fen);
  if (!verdict || verdict.status !== 'checkmate') return null;
  try {
    const chess = new Chess(fen);
    const kingColor = chess.turn();
    const board = chess.board();
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const piece = board[row][col];
        if (piece?.type !== 'k' || piece.color !== kingColor) continue;
        const king = `${FILES[col]}${8 - row}`;
        const attackers = chess.attackers(king as Square, kingColor === 'w' ? 'b' : 'w');
        return { king, attackers, arrows: attackers.map((from) => ({ from, to: king, color: '#d65d4f' })) };
      }
    }
    return null;
  } catch {
    return null;
  }
}
