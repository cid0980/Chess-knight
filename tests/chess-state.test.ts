import assert from 'node:assert/strict';
import test from 'node:test';
import { Chess } from 'chess.js';
import {
  applyRelayedSnapshot,
  decideIncomingSnapshot,
  mateInfoFromFen,
  positionVerdict,
  reconcileGameSnapshot,
  winnerIdFor,
} from '../lib/chess-state';
import type { GameRecord } from '../lib/types';

const WHITE = `kc_${'a'.repeat(32)}`;
const BLACK = `kc_${'b'.repeat(32)}`;
const OTHER = `kc_${'c'.repeat(32)}`;
const START_FEN = new Chess().fen();
const MATE_FEN = (() => {
  const chess = new Chess();
  ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'].forEach((move) => chess.move(move));
  return chess.fen();
})();
const BEFORE_MATE_FEN = (() => {
  const chess = new Chess();
  ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6'].forEach((move) => chess.move(move));
  return chess.fen();
})();
const STALEMATE_FEN = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';

function makeGame(overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    id: `g_${'1'.repeat(32)}`,
    white_id: WHITE,
    black_id: BLACK,
    invited_by: WHITE,
    invited_user_id: BLACK,
    status: 'active',
    fen: BEFORE_MATE_FEN,
    pgn: '',
    turn_user_id: BLACK,
    time_control_seconds: 300,
    increment_seconds: 0,
    white_clock_ms: 290_000,
    black_clock_ms: 280_000,
    started_at: '2026-01-01T00:00:00.000Z',
    turn_started_at: '2026-01-01T00:01:00.000Z',
    finished_at: null,
    winner_id: null,
    result_reason: null,
    moves_count: 6,
    version: 7,
    last_move: { from: 'g8', to: 'f6', san: 'Nf6' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    moves: [],
    actions: [],
    localOnly: false,
    ...overrides,
  };
}

test('positionVerdict reads results off the board', () => {
  assert.equal(positionVerdict(START_FEN), null);
  assert.deepEqual(positionVerdict(MATE_FEN), { status: 'checkmate', result_reason: 'checkmate', winner_color: 'w' });
  assert.equal(positionVerdict(STALEMATE_FEN)?.status, 'stalemate');
  assert.equal(positionVerdict('4k3/8/8/8/8/8/8/3K4 w - - 0 1')?.result_reason, 'insufficient_material');
  assert.equal(positionVerdict('not-a-fen'), null);
});

test('winnerIdFor maps the mating colour to a player id', () => {
  const game = makeGame();
  assert.equal(winnerIdFor(game, { status: 'checkmate', result_reason: 'checkmate', winner_color: 'w' }), WHITE);
  assert.equal(winnerIdFor(game, { status: 'checkmate', result_reason: 'checkmate', winner_color: 'b' }), BLACK);
  assert.equal(winnerIdFor(game, { status: 'draw', result_reason: 'stalemate', winner_color: null }), null);
});

test('reconcileGameSnapshot finalizes a snapshot that still says active', () => {
  const game = makeGame({ status: 'active', fen: MATE_FEN, version: 9, turn_user_id: BLACK });
  const { game: corrected, corrected: changed } = reconcileGameSnapshot(game, '2026-01-01T00:02:00.000Z');
  assert.equal(changed, true);
  assert.equal(corrected.status, 'checkmate');
  assert.equal(corrected.winner_id, WHITE);
  assert.equal(corrected.result_reason, 'checkmate');
  assert.equal(corrected.turn_user_id, null);
  assert.equal(corrected.turn_started_at, null);
  assert.equal(corrected.finished_at, '2026-01-01T00:02:00.000Z');
  assert.equal(corrected.version, 10);
  assert.equal(corrected.fen, game.fen);
});

test('reconcileGameSnapshot leaves consistent final snapshots untouched', () => {
  const checkmate = makeGame({ status: 'checkmate', fen: MATE_FEN, winner_id: WHITE, result_reason: 'checkmate', version: 12, turn_user_id: null });
  assert.equal(reconcileGameSnapshot(checkmate).corrected, false);
  const agreedDraw = makeGame({ status: 'draw', result_reason: 'agreed_draw', winner_id: null, fen: START_FEN });
  assert.equal(reconcileGameSnapshot(agreedDraw).corrected, false);
  const resigned = makeGame({ status: 'resigned', winner_id: WHITE, result_reason: 'resignation', fen: START_FEN });
  assert.equal(reconcileGameSnapshot(resigned).corrected, false);
});

test('reconcileGameSnapshot repairs a wrong result and a missing winner', () => {
  const mislabelled = makeGame({ status: 'draw', fen: MATE_FEN, winner_id: null, result_reason: 'draw' });
  const repaired = reconcileGameSnapshot(mislabelled);
  assert.equal(repaired.corrected, true);
  assert.equal(repaired.game.status, 'checkmate');
  assert.equal(repaired.game.winner_id, WHITE);

  const missingWinner = makeGame({ status: 'checkmate', fen: MATE_FEN, winner_id: null, result_reason: 'checkmate' });
  const filled = reconcileGameSnapshot(missingWinner);
  assert.equal(filled.corrected, true);
  assert.equal(filled.game.winner_id, WHITE);
});

test('decideIncomingSnapshot accepts newer snapshots and ignores stale ones', () => {
  const current = makeGame({ version: 7 });
  const newer = makeGame({ version: 8, fen: MATE_FEN });
  assert.equal(decideIncomingSnapshot(current, newer).accepted, true);

  const sameVersion = makeGame({ version: 7, moves_count: 6 });
  assert.equal(decideIncomingSnapshot(current, sameVersion).accepted, false);
  assert.equal(decideIncomingSnapshot(current, sameVersion).reason, 'ignored-stale');

  const otherGame = makeGame({ id: `g_${'2'.repeat(32)}`, version: 99 });
  assert.equal(decideIncomingSnapshot(current, otherGame).reason, 'ignored-other-game');
});

test('decideIncomingSnapshot lets a final result win a version collision', () => {
  // Both clients bumped to 9 while trading events, so the mate snapshot is not "newer".
  const current = makeGame({ version: 9, status: 'active', moves_count: 6 });
  const mate = makeGame({ version: 9, status: 'checkmate', fen: MATE_FEN, winner_id: WHITE, result_reason: 'checkmate', moves_count: 7, turn_user_id: null });
  const decision = decideIncomingSnapshot(current, mate, '2026-01-01T00:03:00.000Z');
  assert.equal(decision.accepted, true);
  assert.equal(decision.reason, 'applied-final-result');
  assert.equal(decision.rebroadcast, true);
  assert.equal(decision.game.status, 'checkmate');
  assert.equal(decision.game.winner_id, WHITE);
  assert.equal(decision.game.version, 10, 'the applied snapshot is advanced so the peer converges too');
});

test('decideIncomingSnapshot corrects an active snapshot whose board is already mate', () => {
  const current = makeGame({ version: 9, moves_count: 6 });
  const staleFlag = makeGame({ version: 9, status: 'active', fen: MATE_FEN, moves_count: 7 });
  const decision = decideIncomingSnapshot(current, staleFlag);
  assert.equal(decision.accepted, true);
  assert.equal(decision.game.status, 'checkmate');
  assert.equal(decision.game.winner_id, WHITE);
  assert.equal(decision.rebroadcast, true, 'the sender is told the game actually ended');
});

test('decideIncomingSnapshot refuses to demote progress', () => {
  const current = makeGame({ version: 12, status: 'active', moves_count: 5, fen: START_FEN });
  const staleFinal = makeGame({ version: 11, status: 'checkmate', fen: MATE_FEN, moves_count: 4, winner_id: WHITE, result_reason: 'checkmate' });
  assert.equal(decideIncomingSnapshot(current, staleFinal).accepted, false);
});

test('applyRelayedSnapshot only accepts opponent updates for the same game', () => {
  const current = makeGame();
  const mate = makeGame({ version: 8, status: 'checkmate', fen: MATE_FEN, winner_id: WHITE, result_reason: 'checkmate', moves_count: 7 });
  assert.equal(applyRelayedSnapshot(current, mate, { fromId: current.black_id, localPlayerId: current.white_id }).accepted, true);
  assert.equal(applyRelayedSnapshot(current, mate, { fromId: current.white_id, localPlayerId: current.white_id }).accepted, false, 'own echoes are ignored');
  assert.equal(applyRelayedSnapshot(current, mate, { fromId: OTHER, localPlayerId: current.white_id }).accepted, false, 'strangers cannot move the game');
  assert.equal(applyRelayedSnapshot(current, mate, { fromId: '', localPlayerId: current.white_id }).accepted, false);
});

test('applyRelayedSnapshot reports the final result and move sound', () => {
  const current = makeGame({ version: 9, moves_count: 6 });
  const mate = makeGame({ version: 9, status: 'checkmate', fen: MATE_FEN, winner_id: WHITE, result_reason: 'checkmate', moves_count: 7 });
  const application = applyRelayedSnapshot(current, mate, { fromId: current.black_id, localPlayerId: current.white_id });
  assert.deepEqual(
    { accepted: application.accepted, finished: application.finished, sound: application.sound, rebroadcast: application.rebroadcast },
    { accepted: true, finished: true, sound: true, rebroadcast: true },
  );
});

test('a colliding resignation stays out until a strictly newer snapshot arrives', () => {
  // Intentional boundary: only FEN-provable results (mate/stalemate/draw) override a
  // version collision. A stale resignation must never undo a takeback.
  const current = makeGame({ version: 9, status: 'active' });
  const resigned = makeGame({ version: 9, status: 'resigned', winner_id: WHITE, result_reason: 'resignation', turn_user_id: null });
  assert.equal(applyRelayedSnapshot(current, resigned, { fromId: current.black_id, localPlayerId: current.white_id }).accepted, false);
  const newer = { ...resigned, version: 10 };
  assert.equal(applyRelayedSnapshot(current, newer, { fromId: current.black_id, localPlayerId: current.white_id }).accepted, true);
});

test('mateInfoFromFen derives the king, the attackers and the arrows from the board', () => {
  const info = mateInfoFromFen(MATE_FEN);
  assert.ok(info);
  assert.equal(info.king, 'e8');
  assert.deepEqual(info.attackers, ['f7']);
  assert.deepEqual(info.arrows, [{ from: 'f7', to: 'e8', color: '#d65d4f' }]);
  assert.equal(mateInfoFromFen(BEFORE_MATE_FEN), null, 'a flagged checkmate is not needed to find the mark');
  assert.equal(mateInfoFromFen(STALEMATE_FEN), null);
});
