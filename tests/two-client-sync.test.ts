import assert from 'node:assert/strict';
import test from 'node:test';
import { Chess } from 'chess.js';
import {
  applyRelayedSnapshot,
  positionVerdict,
  reconcileGameSnapshot,
  winnerIdFor,
} from '../lib/chess-state';
import type { GameMove, GameRecord } from '../lib/types';

/**
 * Two-client relay simulation.
 *
 * Two independent clients own a snapshot of the same game and exchange whole
 * snapshots over the (lossy, unordered) relay, exactly like the browser clients
 * do. Everything that decides whether an update is accepted, corrected or
 * rebroadcast is the production code in lib/chess-state.ts — the same functions
 * the game room calls. Only the "a player made a move" helper below is local to
 * this test, because it mirrors the snapshot bookkeeping that commitMove does in
 * the component (clocks, move list, PGN, version).
 */

const WHITE = `kc_${'a'.repeat(32)}`;
const BLACK = `kc_${'b'.repeat(32)}`;
const START = new Chess();

type Client = { id: string; game: GameRecord; finished: boolean; premove: { from: string; to: string } | null };

/** Minimal stand-in for the snapshot commitMove stores locally. */
function playMove(client: Client, san: string, now = new Date().toISOString()): GameRecord {
  const chess = new Chess(client.game.fen);
  const played = chess.move(san);
  const verdict = positionVerdict(chess.fen());
  const move: GameMove = {
    from_square: played.from,
    to_square: played.to,
    promotion: played.promotion || null,
    san: played.san,
    fen_after: chess.fen(),
    pgn_after: chess.pgn(),
    turn_user_id: verdict ? null : chess.turn() === 'w' ? client.game.white_id : client.game.black_id,
    created_at: now,
  };
  const next: GameRecord = {
    ...client.game,
    fen: chess.fen(),
    pgn: chess.pgn(),
    status: verdict?.status ?? 'active',
    winner_id: verdict ? winnerIdFor(client.game, verdict) : null,
    result_reason: verdict?.result_reason ?? null,
    turn_user_id: verdict ? null : chess.turn() === 'w' ? client.game.white_id : client.game.black_id,
    turn_started_at: verdict ? null : now,
    finished_at: verdict ? now : null,
    moves_count: client.game.moves_count + 1,
    version: client.game.version + 1,
    last_move: { from: played.from, to: played.to, san: played.san },
    moves: [...(client.game.moves || []), move],
    updated_at: now,
  };
  client.game = next;
  if (next.status !== 'active') client.premove = null;
  return next;
}

function initialGame(): GameRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: `g_${'9'.repeat(32)}`,
    white_id: WHITE,
    black_id: BLACK,
    invited_by: WHITE,
    invited_user_id: BLACK,
    status: 'active',
    fen: START.fen(),
    pgn: '',
    turn_user_id: WHITE,
    time_control_seconds: 300,
    increment_seconds: 0,
    white_clock_ms: 300_000,
    black_clock_ms: 300_000,
    started_at: now,
    turn_started_at: now,
    finished_at: null,
    winner_id: null,
    result_reason: null,
    moves_count: 0,
    version: 1,
    last_move: null,
    created_at: now,
    updated_at: now,
    moves: [],
    actions: [],
    localOnly: false,
  };
}

/** Delivers a snapshot over the wire (JSON round-trip) and honours rebroadcasts. */
function deliver(sender: Client, recipient: Client, snapshot: GameRecord) {
  const wire = JSON.parse(JSON.stringify(snapshot)) as GameRecord;
  const application = applyRelayedSnapshot(recipient.game, wire, { fromId: sender.id, localPlayerId: recipient.id });
  if (!application.accepted) return application;
  recipient.game = application.game;
  if (application.finished) recipient.premove = null;
  if (application.rebroadcast) {
    // The recipient answers with the corrected snapshot, which converges the sender.
    const back = applyRelayedSnapshot(sender.game, application.game, { fromId: recipient.id, localPlayerId: sender.id });
    if (back.accepted) sender.game = back.game;
  }
  return application;
}

test('both players see the checkmate even when their versions collide', () => {
  const white: Client = { id: WHITE, game: initialGame(), finished: false, premove: null };
  const black: Client = { id: BLACK, game: initialGame(), finished: false, premove: null };
  black.game = { ...black.game };
  white.game = { ...white.game };

  // Six plies played normally, staying in sync.
  const opening = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6'];
  opening.forEach((san, index) => {
    const mover = index % 2 === 0 ? white : black;
    const snapshot = playMove(mover, san);
    deliver(mover, mover === white ? black : white, snapshot);
  });
  assert.equal(black.game.fen, white.game.fen);

  // The receiver bumps its own version (for example by sending a draw offer) while
  // the mover delivers mate. The mate snapshot is no longer "strictly newer".
  const bump = { ...black.game, version: black.game.version + 1, updated_at: '2026-01-01T00:05:00.000Z' };
  black.game = bump;
  black.premove = { from: 'd8', to: 'h4' }; // a queued premove, as in a live game

  const mate = playMove(white, 'Qxf7#');
  assert.equal(mate.status, 'checkmate');

  const application = deliver(white, black, mate);
  assert.equal(application.accepted, true, 'the final result must not be dropped by the version gate');
  assert.equal(application.finished, true);

  assert.equal(black.game.status, 'checkmate');
  assert.equal(black.game.winner_id, WHITE);
  assert.equal(black.premove, null, 'queued premoves are cleared when play ends');
  assert.equal(white.game.status, 'checkmate');
  assert.equal(white.game.winner_id, WHITE);
  assert.equal(black.game.version, white.game.version, 'both clients converge on the same version');
  assert.equal(black.game.fen, white.game.fen);
});

test('a mate that was stored while still marked active is corrected and rebroadcast', () => {
  const white: Client = { id: WHITE, game: initialGame(), finished: false, premove: null };
  const black: Client = { id: BLACK, game: initialGame(), finished: false, premove: null };
  ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6'].forEach((san, index) => {
    const mover = index % 2 === 0 ? white : black;
    const snapshot = playMove(mover, san);
    deliver(mover, mover === white ? black : white, snapshot);
  });

  const mate = playMove(white, 'Qxf7#');
  // Simulates the reported bug: the snapshot carries the mating move but not the result.
  const staleSnapshot: GameRecord = { ...mate, status: 'active', winner_id: null, result_reason: null, turn_user_id: BLACK, finished_at: null };

  const application = deliver(white, black, staleSnapshot);
  assert.equal(application.accepted, true);
  assert.equal(black.game.status, 'checkmate');
  assert.equal(black.game.winner_id, WHITE);
  assert.equal(black.game.result_reason, 'checkmate');
  assert.equal(white.game.status, 'checkmate', 'the sender is corrected by the rebroadcast');
  assert.equal(white.game.version, black.game.version);
});

test('a client that reconnects with a stale board finalizes on its own', () => {
  const white: Client = { id: WHITE, game: initialGame(), finished: false, premove: null };
  const black: Client = { id: BLACK, game: initialGame(), finished: false, premove: null };
  ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6'].forEach((san, index) => {
    const mover = index % 2 === 0 ? white : black;
    const snapshot = playMove(mover, san);
    deliver(mover, mover === white ? black : white, snapshot);
  });
  const mate = playMove(white, 'Qxf7#');

  // The black tab was closed or asleep: it restores its own last snapshot, which is
  // the mate position still labelled active (the flag was never persisted).
  const restored: GameRecord = { ...mate, status: 'active', winner_id: null, result_reason: null, turn_user_id: BLACK, finished_at: null };
  const { game: healed, corrected } = reconcileGameSnapshot(restored);
  assert.equal(corrected, true);
  black.game = healed;
  assert.equal(black.game.status, 'checkmate');

  // It then answers the next sync request, and white accepts the healed snapshot.
  const application = deliver(black, white, black.game);
  assert.equal(application.accepted, true);
  assert.equal(white.game.status, 'checkmate');
  assert.equal(white.game.winner_id, WHITE);
  assert.equal(white.game.version, black.game.version);
});

test('a finished result is never revived, while a newer ending still lands', () => {
  const white: Client = { id: WHITE, game: initialGame(), finished: false, premove: null };
  const black: Client = { id: BLACK, game: initialGame(), finished: false, premove: null };
  const draw: GameRecord = { ...white.game, status: 'draw', result_reason: 'agreed_draw', winner_id: null, version: 9, updated_at: '2026-01-01T00:06:00.000Z' };
  white.game = draw;
  black.game = { ...draw, version: 10 };

  // A stale active snapshot from before the draw offer must not revive the game.
  const stale: GameRecord = { ...initialGame(), version: 8 };
  assert.equal(deliver(white, black, stale).accepted, false);
  assert.equal(black.game.status, 'draw');

  // Once a game is finished it is never revived, not even by a higher version.
  const newerActive: GameRecord = { ...initialGame(), version: 11 };
  assert.equal(deliver(white, black, newerActive).accepted, false);
  assert.equal(black.game.status, 'draw');
  assert.equal(white.game.status, 'draw');

  // A higher-version final snapshot still propagates, so a late resignation lands.
  const resigned: GameRecord = { ...initialGame(), status: 'resigned', winner_id: WHITE, result_reason: 'resignation', version: 12, turn_user_id: null };
  assert.equal(deliver(white, black, resigned).accepted, true);
  assert.equal(black.game.status, 'resigned');
});
