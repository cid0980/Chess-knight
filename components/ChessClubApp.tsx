'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Pusher from 'pusher-js';
import {
  AlertTriangle, ArrowLeft, ArrowRight, Bell, Check, CheckCheck, ChevronDown, ChevronRight,
  Clock3, Copy, Crown, Flag, Handshake, History, Inbox, KeyRound, LoaderCircle, LockKeyhole,
  MessageCircle, MoveUpRight, Play, Plus, Radio, RotateCcw, Search, Send, Settings, Shield,
  Sparkles, Swords, Timer, Trophy, UserPlus, UsersRound, Volume2, VolumeX, Wifi, WifiOff, X,
} from 'lucide-react';
import { Chess, type Square } from 'chess.js';
import ChessBoard, { type BoardArrow } from '@/components/ChessBoard';
import { canonicalJson } from '@/lib/canonical-json';
import type { FriendRecord, FriendRequest, GameAction, GameActionType, GameMove, GameRecord, PlayerProfile, ToastMessage } from '@/lib/types';

type Tab = 'play' | 'friends' | 'inbox' | 'history' | 'settings';
type Runtime = 'loading' | 'local' | 'live';
type BoardTheme = 'classic' | 'wood' | 'slate';
type Premove = { from: string; to: string; promotion?: string };
type PendingChallenge = { id: string; from: PlayerProfile; game: GameRecord; created_at: string };
type RematchRequest = { fromId: string; game: GameRecord };
type LocalPreferences = { boardTheme: BoardTheme; coordinates: boolean; sound: boolean; notifications: boolean };
type DeviceLock = { salt: string; hash: string };
type PusherClient = InstanceType<typeof Pusher>;
type RelayChannel = ReturnType<PusherClient['subscribe']>;

const PROFILE_KEY = 'knightclub:v2:profile';
const FRIENDS_KEY = 'knightclub:v2:friends';
const PREFS_KEY = 'knightclub:v2:preferences';
const LOCK_KEY = 'knightclub:v2:device-lock';
const ACTIVE_GAME_KEY = 'knightclub:active-game';
const PRESENCE_CHANNEL = 'presence-knightclub-v1';
const DEFAULT_PREFS: LocalPreferences = { boardTheme: 'classic', coordinates: true, sound: true, notifications: false };
const TIME_OPTIONS = [
  { label: '3 min', seconds: 180, increment: 0, name: 'Blitz' },
  { label: '5 min', seconds: 300, increment: 0, name: 'Blitz' },
  { label: '10 min', seconds: 600, increment: 0, name: 'Rapid' },
  { label: '15 + 10', seconds: 900, increment: 10, name: 'Rapid' },
  { label: '30 min', seconds: 1800, increment: 0, name: 'Classical' },
];
const INITIAL_FEN = new Chess().fen();
const PLAYER_ID_RE = /^kc_[a-f0-9]{32}$/;
const PUBLIC_ID_RE = /^pu_[a-f0-9]{32}$/;
const GAME_ID_RE = /^g_[a-f0-9]{32}$/;

function randomHex(bytes = 16) {
  const values = new Uint8Array(bytes);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) window.crypto.getRandomValues(values);
  else for (let index = 0; index < values.length; index += 1) values[index] = Math.floor(Math.random() * 256);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

function createGameId() {
  return `g_${randomHex(16)}`;
}

async function publicIdFor(clientId: string) {
  try {
    const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientId));
    const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    return `pu_${hex.slice(0, 32)}`;
  } catch {
    return `pu_${randomHex(16)}`;
  }
}

function makeFriendCode(id: string) {
  return id.startsWith('kc_') ? `KC-${id.slice(3).toUpperCase()}` : id;
}

function parseFriendCode(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[\s-]/g, '');
  const hex = normalized.startsWith('kc_') ? normalized.slice(3) : normalized.startsWith('kc') ? normalized.slice(2) : normalized;
  if (!/^[a-f0-9]{32}$/.test(hex)) return null;
  return `kc_${hex}`;
}

async function createProfile(): Promise<PlayerProfile> {
  const id = `kc_${randomHex(16)}`;
  return {
    id,
    public_id: await publicIdFor(id),
    friend_code: makeFriendCode(id),
    username: `player-${id.slice(-4)}`,
    display_name: 'Chess player',
  };
}

function isProfile(value: unknown): value is PlayerProfile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as PlayerProfile;
  return PLAYER_ID_RE.test(candidate.id) && PUBLIC_ID_RE.test(candidate.public_id) && typeof candidate.display_name === 'string';
}

function sanitizeProfile(value: unknown): PlayerProfile | null {
  if (!isProfile(value)) return null;
  const displayName = value.display_name.trim().slice(0, 32) || 'Chess player';
  return { ...value, friend_code: makeFriendCode(value.id), display_name: displayName, username: value.username || `player-${value.id.slice(-4)}` };
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'K';
}

function safeChess(game: Pick<GameRecord, 'fen' | 'pgn'>) {
  const chess = new Chess();
  if (game.pgn) {
    try { chess.loadPgn(game.pgn); return chess; } catch { /* Use the validated FEN fallback. */ }
  }
  chess.load(game.fen || INITIAL_FEN);
  return chess;
}

function legalTargetsFor(fen: string, from: string, color: 'w' | 'b') {
  try {
    const fields = fen.split(' ');
    if (fields.length >= 2) fields[1] = color;
    const chess = new Chess(fields.join(' '));
    return chess.moves({ square: from as Square, verbose: true }).map((move) => move.to);
  } catch {
    return [];
  }
}

function formatClock(milliseconds: number) {
  const safe = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function clocksFor(game: GameRecord, now: number) {
  const white = Math.max(0, game.white_clock_ms);
  const black = Math.max(0, game.black_clock_ms);
  if (game.status !== 'active' || !game.turn_user_id || !game.turn_started_at) return { white, black };
  const elapsed = Math.max(0, now - new Date(game.turn_started_at).getTime());
  if (game.turn_user_id === game.white_id) return { white: Math.max(0, white - elapsed), black };
  return { white, black: Math.max(0, black - elapsed) };
}

function timeControlLabel(game: Pick<GameRecord, 'time_control_seconds' | 'increment_seconds'>) {
  const minutes = Math.floor(game.time_control_seconds / 60);
  return game.increment_seconds ? `${minutes} + ${game.increment_seconds}` : `${minutes} min`;
}

function statusLabel(game: GameRecord) {
  if (game.status === 'checkmate') return 'Checkmate';
  if (game.status === 'stalemate') return 'Stalemate';
  if (game.status === 'resigned') return 'Resignation';
  if (game.status === 'timeout') return 'Time expired';
  if (game.status === 'draw') return 'Draw';
  if (game.status === 'declined') return 'Declined';
  if (game.status === 'pending') return 'Waiting for player';
  return 'In progress';
}

function winnerSentence(game: GameRecord, playerId: string) {
  if (game.status === 'stalemate' || game.status === 'draw') return 'The game ended in a draw.';
  if (game.status === 'declined') return 'The challenge was declined.';
  const winner = game.winner_id === playerId ? 'You won' : 'Your opponent won';
  if (game.status === 'checkmate') return `${winner} by checkmate.`;
  if (game.status === 'resigned') return `${winner} by resignation.`;
  if (game.status === 'timeout') return `${winner} on time.`;
  return 'The game is over.';
}

function createGame(whiteId: string, blackId: string, time: number, increment: number, invitedBy: string, status: GameRecord['status'], localOnly = false): GameRecord {
  const now = new Date().toISOString();
  return {
    id: createGameId(), white_id: whiteId, black_id: blackId, invited_by: invitedBy,
    invited_user_id: invitedBy === whiteId ? blackId : whiteId, status,
    fen: INITIAL_FEN, pgn: '', turn_user_id: status === 'active' ? whiteId : whiteId,
    time_control_seconds: time, increment_seconds: increment,
    white_clock_ms: time * 1000, black_clock_ms: time * 1000,
    started_at: status === 'active' ? now : null, turn_started_at: status === 'active' ? now : null,
    finished_at: null, winner_id: null, result_reason: null, moves_count: 0, version: status === 'active' ? 1 : 0,
    last_move: null, created_at: now, updated_at: now, moves: [], actions: [], localOnly,
  };
}

function isValidGame(value: unknown): value is GameRecord {
  if (!value || typeof value !== 'object') return false;
  const game = value as GameRecord;
  if (!GAME_ID_RE.test(game.id) || typeof game.fen !== 'string' || typeof game.pgn !== 'string') return false;
  if (!['pending', 'active', 'checkmate', 'draw', 'stalemate', 'resigned', 'timeout', 'declined'].includes(game.status)) return false;
  if (!PLAYER_ID_RE.test(game.white_id) || !PLAYER_ID_RE.test(game.black_id)) return false;
  try { new Chess(game.fen); return true; } catch { return false; }
}

type CompactMove = [string, string, string, string, number | null, number | null];
type CompactGameSnapshot = Omit<GameRecord, 'moves'> & { moves: CompactMove[] };

function encodeGameSnapshot(game: GameRecord): CompactGameSnapshot {
  return {
    ...game,
    moves: (game.moves || []).map((move) => [
      move.from_square, move.to_square, move.promotion || '', move.san,
      typeof move.white_clock_ms === 'number' ? move.white_clock_ms : null,
      typeof move.black_clock_ms === 'number' ? move.black_clock_ms : null,
    ]),
  };
}

function decodeGameSnapshot(value: unknown): GameRecord | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as Record<string, unknown>;
  const compactMoves = Array.isArray(snapshot.moves) ? snapshot.moves.slice(0, 500) : [];
  const moves: GameMove[] = compactMoves.flatMap((entry) => {
    if (Array.isArray(entry)) {
      const [from, to, promotion, san, whiteClock, blackClock] = entry;
      if (typeof from !== 'string' || typeof to !== 'string' || !/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to) || typeof san !== 'string') return [];
      return [{ from_square: from, to_square: to, promotion: promotion ? String(promotion) : null, san, white_clock_ms: typeof whiteClock === 'number' ? whiteClock : undefined, black_clock_ms: typeof blackClock === 'number' ? blackClock : undefined }];
    }
    if (entry && typeof entry === 'object' && typeof (entry as GameMove).from_square === 'string' && typeof (entry as GameMove).to_square === 'string') return [entry as GameMove];
    return [];
  });
  const decoded = { ...snapshot, moves } as unknown as GameRecord;
  return isValidGame(decoded) ? decoded : null;
}

function mateInfo(game: GameRecord | null): { king: string; arrows: BoardArrow[]; attackers: string[] } | null {
  if (!game || game.status !== 'checkmate') return null;
  try {
    const chess = new Chess(game.fen);
    const kingColor = chess.turn();
    const board = chess.board();
    const row = board.findIndex((rank) => rank.some((piece) => piece?.type === 'k' && piece.color === kingColor));
    if (row < 0) return null;
    const col = board[row].findIndex((piece) => piece?.type === 'k' && piece.color === kingColor);
    const king = `${'abcdefgh'[col]}${8 - row}`;
    const attackers = chess.attackers(king as Square, kingColor === 'w' ? 'b' : 'w');
    return { king, attackers, arrows: attackers.map((from) => ({ from, to: king, color: '#d65d4f' })) };
  } catch { return null; }
}

function allMoves(game: GameRecord) {
  if (game.moves?.length) return game.moves;
  try {
    return safeChess(game).history({ verbose: true }).map((move) => ({
      from_square: move.from, to_square: move.to, promotion: move.promotion, san: move.san,
    }));
  } catch { return []; }
}

function fenAfterMoves(moves: GameMove[], count: number) {
  const chess = new Chess();
  for (const move of moves.slice(0, count)) {
    try { chess.move({ from: move.from_square, to: move.to_square, ...(move.promotion ? { promotion: move.promotion } : {}) }); }
    catch { break; }
  }
  return chess.fen();
}

async function makePasswordHash(password: string, saltHex: string) {
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
  const key = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await window.crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 180_000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function signRelayEnvelope(secret: string, envelope: Record<string, unknown>) {
  const key = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await window.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonicalJson(envelope)));
  return Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, '0')).join('');
}

function playMoveTone(enabled: boolean) {
  if (!enabled || typeof window === 'undefined') return;
  try {
    const audio = new window.AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = 540; gain.gain.value = 0.035;
    oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + 0.055);
    window.setTimeout(() => void audio.close(), 150);
  } catch { /* Audio is optional. */ }
}

export default function ChessClubApp() {
  const [runtime, setRuntime] = useState<Runtime>('loading');
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [friends, setFriends] = useState<FriendRecord[]>([]);
  const [knownPlayers, setKnownPlayers] = useState<Record<string, PlayerProfile>>({});
  const [onlinePublicIds, setOnlinePublicIds] = useState<Set<string>>(new Set());
  const [preferences, setPreferences] = useState<LocalPreferences>(DEFAULT_PREFS);
  const [deviceLock, setDeviceLock] = useState<DeviceLock | null>(null);
  const [locked, setLocked] = useState(false);
  const [unlockInput, setUnlockInput] = useState('');
  const [lockCurrentInput, setLockCurrentInput] = useState('');
  const [lockNewInput, setLockNewInput] = useState('');
  const [lockConfirmInput, setLockConfirmInput] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('play');
  const [activeView, setActiveView] = useState<'lobby' | 'game'>('lobby');
  const [currentGame, setCurrentGame] = useState<GameRecord | null>(null);
  const [games, setGames] = useState<GameRecord[]>([]);
  const [incomingChallenges, setIncomingChallenges] = useState<PendingChallenge[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [outgoingFriendIds, setOutgoingFriendIds] = useState<string[]>([]);
  const [rematchIncoming, setRematchIncoming] = useState<RematchRequest | null>(null);
  const [rematchWaiting, setRematchWaiting] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [connectionState, setConnectionState] = useState('connecting');
  const [pusherClient, setPusherClient] = useState<PusherClient | null>(null);
  const [search, setSearch] = useState('');
  const [friendCodeInput, setFriendCodeInput] = useState('');
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [selectedTime, setSelectedTime] = useState(300);
  const [now, setNow] = useState(Date.now());
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalTargets, setLegalTargets] = useState<string[]>([]);
  const [queuedPremove, setQueuedPremove] = useState<Premove | null>(null);
  const [promotion, setPromotion] = useState<{ from: string; to: string } | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [resignConfirm, setResignConfirm] = useState(false);
  const pusherRef = useRef<PusherClient | null>(null);
  const currentGameRef = useRef<GameRecord | null>(null);
  const profileRef = useRef<PlayerProfile | null>(null);
  const friendsRef = useRef<FriendRecord[]>([]);
  const preferencesRef = useRef(preferences);
  const onlinePublicIdsRef = useRef<Set<string>>(new Set());
  const toastTimerRef = useRef<number | null>(null);
  const rematchWaitingRef = useRef(false);

  const liveConfigured = Boolean(process.env.NEXT_PUBLIC_PUSHER_KEY && process.env.NEXT_PUBLIC_PUSHER_CLUSTER);
  const connected = connectionState === 'connected';
  const incomingCount = incomingChallenges.length + friendRequests.filter((request) => request.direction === 'incoming').length;
  const onlineFriendCount = friends.filter((friend) => onlinePublicIds.has(friend.public_id)).length;

  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { friendsRef.current = friends; }, [friends]);
  useEffect(() => { preferencesRef.current = preferences; }, [preferences]);
  useEffect(() => { onlinePublicIdsRef.current = onlinePublicIds; }, [onlinePublicIds]);
  useEffect(() => { currentGameRef.current = currentGame; }, [currentGame]);
  useEffect(() => { rematchWaitingRef.current = rematchWaiting; }, [rematchWaiting]);

  const notify = useCallback((text: string, tone: ToastMessage['tone'] = 'info') => {
    setToast({ id: Date.now(), text, tone });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4300);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadLocalState() {
      let storedProfile: PlayerProfile | null = null;
      try { storedProfile = sanitizeProfile(JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null')); } catch { /* Fresh browser. */ }
      if (!storedProfile) {
        storedProfile = await createProfile();
        try { localStorage.setItem(PROFILE_KEY, JSON.stringify(storedProfile)); } catch { /* Private browsing may disable storage. */ }
      }
      let storedFriends: FriendRecord[] = [];
      try {
        const parsed = JSON.parse(localStorage.getItem(FRIENDS_KEY) || '[]');
        if (Array.isArray(parsed)) storedFriends = parsed.filter((friend) => isProfile(friend)).map((friend) => ({ ...sanitizeProfile(friend)!, online: false }));
      } catch { /* Ignore malformed local data. */ }
      let storedPrefs = DEFAULT_PREFS;
      try { storedPrefs = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { /* Use defaults. */ }
      let storedLock: DeviceLock | null = null;
      try {
        const parsedLock = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
        if (parsedLock && /^[a-f0-9]{32}$/.test(parsedLock.salt) && /^[a-f0-9]{64}$/.test(parsedLock.hash)) storedLock = parsedLock;
      } catch { /* Ignore malformed lock data. */ }
      let storedGame: GameRecord | null = null;
      try {
        const candidate = JSON.parse(sessionStorage.getItem(ACTIVE_GAME_KEY) || 'null');
        if (isValidGame(candidate) && candidate.status === 'active' && !candidate.localOnly && [candidate.white_id, candidate.black_id].includes(storedProfile.id)) storedGame = candidate;
      } catch { /* No local active match. */ }
      if (cancelled) return;
      setProfile(storedProfile);
      setDisplayNameInput(storedProfile.display_name);
      setFriends(storedFriends);
      setKnownPlayers(Object.fromEntries(storedFriends.map((friend) => [friend.id, friend])));
      setPreferences(storedPrefs);
      setDeviceLock(storedLock);
      setLocked(Boolean(storedLock));
      if (storedGame) { setCurrentGame(storedGame); setGames([storedGame]); }
      setRuntime(liveConfigured ? 'live' : 'local');
    }
    void loadLocalState();
    return () => { cancelled = true; };
  }, [liveConfigured]);

  useEffect(() => {
    if (profile) {
      try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* Local-only storage is best effort. */ }
    }
  }, [profile]);
  useEffect(() => {
    try { localStorage.setItem(FRIENDS_KEY, JSON.stringify(friends.map(({ online: _online, ...friend }) => friend))); } catch { /* Local-only storage is best effort. */ }
  }, [friends]);
  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(preferences)); } catch { /* Local-only storage is best effort. */ }
  }, [preferences]);
  useEffect(() => {
    if (!currentGame || currentGame.localOnly || currentGame.status !== 'active') {
      try { sessionStorage.removeItem(ACTIVE_GAME_KEY); } catch { /* Session storage is optional. */ }
      return;
    }
    try { sessionStorage.setItem(ACTIVE_GAME_KEY, JSON.stringify(currentGame)); } catch { /* Session storage is optional. */ }
  }, [currentGame]);

  const addKnownPlayer = useCallback((player: PlayerProfile) => {
    setKnownPlayers((current) => ({ ...current, [player.id]: player }));
  }, []);

  const addFriendLocally = useCallback((player: PlayerProfile) => {
    const safePlayer = sanitizeProfile(player);
    if (!safePlayer || safePlayer.id === profileRef.current?.id) return;
    setKnownPlayers((current) => ({ ...current, [safePlayer.id]: safePlayer }));
    setFriends((current) => current.some((friend) => friend.id === safePlayer.id)
      ? current.map((friend) => friend.id === safePlayer.id ? { ...safePlayer, online: onlinePublicIdsRef.current.has(safePlayer.public_id) } : friend)
      : [...current, { ...safePlayer, online: onlinePublicIdsRef.current.has(safePlayer.public_id) }]);
  }, []);

  const sendRelayEvent = useCallback(async (targetId: string, eventName: string, payload: unknown) => {
    const sender = profileRef.current;
    const pusher = pusherRef.current;
    const name = eventName.replace(/^client-/, '');
    const allowedEvents = new Set(['friend-request', 'friend-accepted', 'friend-declined', 'challenge', 'challenge-answer']);
    if (!sender || !pusher || pusher.connection.state !== 'connected' || !PLAYER_ID_RE.test(targetId) || !allowedEvents.has(name)) return false;
    const issuedAt = Date.now();
    const envelope = { targetId, eventName: name, fromId: sender.id, issuedAt, data: payload };
    try {
      const signature = await signRelayEnvelope(sender.id, envelope);
      const response = await fetch('/api/pusher/trigger', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...envelope, signature }), cache: 'no-store',
      });
      return response.ok;
    } catch { return false; }
  }, []);

  useEffect(() => {
    if (runtime !== 'live' || !profile || locked || !process.env.NEXT_PUBLIC_PUSHER_KEY || !process.env.NEXT_PUBLIC_PUSHER_CLUSTER) {
      pusherRef.current = null;
      setPusherClient(null);
      setConnectionState(runtime === 'live' ? 'connecting' : 'unavailable');
      return;
    }
    const client = new Pusher(process.env.NEXT_PUBLIC_PUSHER_KEY, {
      cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER,
      forceTLS: true,
      authEndpoint: '/api/pusher/auth',
      authTransport: 'ajax',
      auth: { params: { client_id: profile.id, public_id: profile.public_id, display_name: profile.display_name } },
      disableStats: true,
    });
    pusherRef.current = client;
    setPusherClient(client);
    setConnectionState(client.connection.state);
    const onStateChange = (state: { current: string }) => setConnectionState(state.current);
    client.connection.bind('state_change', onStateChange);
    const presence = client.subscribe(PRESENCE_CHANNEL) as RelayChannel & { members?: { members?: Record<string, unknown> } };
    const updatePresence = () => {
      const memberIds = new Set(Object.keys(presence.members?.members || {}));
      setOnlinePublicIds(memberIds);
      setFriends((current) => current.map((friend) => ({ ...friend, online: memberIds.has(friend.public_id) })));
    };
    presence.bind('pusher:subscription_succeeded', updatePresence);
    presence.bind('pusher:member_added', updatePresence);
    presence.bind('pusher:member_removed', updatePresence);
    return () => {
      client.connection.unbind('state_change', onStateChange);
      presence.unbind('pusher:subscription_succeeded', updatePresence);
      presence.unbind('pusher:member_added', updatePresence);
      presence.unbind('pusher:member_removed', updatePresence);
      pusherRef.current = null;
      setPusherClient(null);
      setConnectionState('unavailable');
      client.disconnect();
    };
  }, [runtime, profile?.id, profile?.public_id, profile?.display_name, locked]);

  useEffect(() => {
    const client = pusherClient;
    if (!client || !profile) return;
    const inbox = client.subscribe(`private-player-${profile.id}`);
    const onFriendRequest = (data: { requestId?: string; from?: PlayerProfile }) => {
      const from = sanitizeProfile(data?.from);
      if (!from || from.id === profile.id) return;
      addKnownPlayer(from);
      const alreadyFriend = friendsRef.current.some((friend) => friend.id === from.id);
      if (alreadyFriend) {
        void sendRelayEvent(from.id, 'friend-accepted', { requestId: data.requestId, friend: profile });
        return;
      }
      setFriendRequests((current) => current.some((request) => request.id === data.requestId)
        ? current
        : [{ id: data.requestId || `fr_${randomHex(8)}`, status: 'pending', direction: 'incoming', created_at: new Date().toISOString(), other_player: from }, ...current]);
      notify(`${from.display_name} sent a friend request.`, 'success');
      if (preferencesRef.current.notifications && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        new Notification('KnightClub · Friend request', { body: `${from.display_name} wants to add you.` });
      }
    };
    const onFriendAccepted = (data: { friend?: PlayerProfile }) => {
      const friend = sanitizeProfile(data?.friend);
      if (!friend) return;
      addFriendLocally(friend);
      setOutgoingFriendIds((current) => current.filter((id) => id !== friend.id));
      notify(`${friend.display_name} is now in your local friends list.`, 'success');
    };
    const onFriendDeclined = (data: { fromId?: string }) => {
      if (!data.fromId) return;
      setOutgoingFriendIds((current) => current.filter((id) => id !== data.fromId));
      notify('Your friend request was declined.', 'info');
    };
    const onChallenge = (data: { game?: GameRecord; from?: PlayerProfile }) => {
      const from = sanitizeProfile(data?.from);
      const game = data?.game;
      if (!from || !isValidGame(game) || game.white_id !== from.id || game.black_id !== profile.id) return;
      addKnownPlayer(from);
      setIncomingChallenges((current) => current.some((challenge) => challenge.id === game.id)
        ? current
        : [{ id: game.id, from, game: { ...game, status: 'pending', localOnly: false }, created_at: new Date().toISOString() }, ...current]);
      notify(`${from.display_name} challenged you to a game.`, 'success');
      if (preferencesRef.current.notifications && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        new Notification('KnightClub · Game challenge', { body: `${from.display_name} invited you to play chess.` });
      }
    };
    const onChallengeAnswer = (data: { gameId?: string; accepted?: boolean; game?: GameRecord }) => {
      const active = currentGameRef.current;
      if (!active || active.id !== data.gameId || active.status !== 'pending') return;
      if (!data.accepted) {
        const declined = { ...active, status: 'declined' as const, finished_at: new Date().toISOString(), version: active.version + 1, updated_at: new Date().toISOString() };
        setCurrentGame(declined); currentGameRef.current = declined;
        notify('Your challenge was declined.', 'info');
        return;
      }
      const accepted = isValidGame(data.game) ? data.game : { ...active, status: 'active' as const, started_at: new Date().toISOString(), turn_started_at: new Date().toISOString(), version: active.version + 1 };
      setCurrentGame(accepted); currentGameRef.current = accepted; setActiveView('game'); setActiveTab('play');
      notify('Challenge accepted. White moves first.', 'success');
    };
    inbox.bind('friend-request', onFriendRequest);
    inbox.bind('friend-accepted', onFriendAccepted);
    inbox.bind('friend-declined', onFriendDeclined);
    inbox.bind('challenge', onChallenge);
    inbox.bind('challenge-answer', onChallengeAnswer);
    inbox.bind('pusher:subscription_error', () => notify('Could not join your private inbox. Check your realtime settings.', 'error'));
    return () => {
      inbox.unbind('friend-request', onFriendRequest);
      inbox.unbind('friend-accepted', onFriendAccepted);
      inbox.unbind('friend-declined', onFriendDeclined);
      inbox.unbind('challenge', onChallenge);
      inbox.unbind('challenge-answer', onChallengeAnswer);
      inbox.unbind('pusher:subscription_error');
      client.unsubscribe(`private-player-${profile.id}`);
    };
  }, [pusherClient, profile?.id, addKnownPlayer, addFriendLocally, notify, sendRelayEvent]);

  useEffect(() => {
    const client = pusherClient;
    const game = currentGame;
    if (!client || !game || game.localOnly || game.status === 'pending' || game.status === 'declined') return;
    const channelName = `private-game-${game.id}`;
    const channel = client.subscribe(channelName);
    let syncSent = false;
    const broadcastSnapshot = (snapshot: GameRecord) => {
      const payload = { fromId: profileRef.current?.id, game: encodeGameSnapshot(snapshot) };
      if (new TextEncoder().encode(JSON.stringify(payload)).length > 9_000) return false;
      return channel.trigger('client-game-update', payload);
    };
    const onUpdate = (data: { fromId?: string; game?: unknown }) => {
      const current = currentGameRef.current;
      const incoming = decodeGameSnapshot(data?.game);
      if (!current || !incoming || incoming.id !== current.id || data.fromId === profileRef.current?.id) return;
      if (incoming.version <= current.version) return;
      if (![current.white_id, current.black_id].includes(data.fromId || '')) return;
      const validPgn = (() => { try { safeChess(incoming); return true; } catch { return false; } })();
      if (!validPgn) return;
      setCurrentGame(incoming); currentGameRef.current = incoming;
      setGames((previous) => upsertGame(previous, incoming));
      setSelectedSquare(null); setLegalTargets([]); setPromotion(null);
      if (preferencesRef.current.sound && incoming.moves_count > current.moves_count) playMoveTone(true);
    };
    const onSyncRequest = (data: { fromId?: string; version?: number }) => {
      const latest = currentGameRef.current;
      if (!latest || latest.id !== game.id || data.fromId === profileRef.current?.id) return;
      if (latest.version >= (data.version || 0)) broadcastSnapshot(latest);
    };
    const onRematchRequest = (data: { fromId?: string; game?: GameRecord }) => {
      const current = currentGameRef.current;
      const player = profileRef.current;
      if (!current || !player || current.id !== game.id || !data.fromId || !isValidGame(data.game) || data.game.status !== 'pending') return;
      const opponentId = current.white_id === player.id ? current.black_id : current.white_id;
      if (data.fromId !== opponentId || ![data.game.white_id, data.game.black_id].includes(player.id)) return;
      setRematchIncoming({ fromId: data.fromId, game: data.game });
      notify('Your opponent offered a rematch.', 'info');
    };
    const onRematchAnswer = (data: { gameId?: string; accepted?: boolean; game?: GameRecord }) => {
      const current = currentGameRef.current;
      if (!current || current.id !== game.id || data.gameId !== current.id || !rematchWaitingRef.current) return;
      setRematchWaiting(false);
      if (!data.accepted || !isValidGame(data.game)) { notify('The rematch was declined.', 'info'); return; }
      setCurrentGame(data.game); currentGameRef.current = data.game; setActiveView('game'); setActiveTab('play');
      notify('Rematch accepted. Colors are switched.', 'success');
    };
    const onSubscription = () => {
      if (syncSent) return;
      syncSent = true;
      channel.trigger('client-sync-request', { fromId: profileRef.current?.id, version: currentGameRef.current?.version || 0 });
    };
    channel.bind('client-game-update', onUpdate);
    channel.bind('client-sync-request', onSyncRequest);
    channel.bind('client-rematch-request', onRematchRequest);
    channel.bind('client-rematch-answer', onRematchAnswer);
    channel.bind('pusher:subscription_succeeded', onSubscription);
    channel.bind('pusher:subscription_error', () => notify('Game relay disconnected. Reconnecting…', 'error'));
    if (channel.subscribed) onSubscription();
    return () => {
      channel.unbind('client-game-update', onUpdate);
      channel.unbind('client-sync-request', onSyncRequest);
      channel.unbind('client-rematch-request', onRematchRequest);
      channel.unbind('client-rematch-answer', onRematchAnswer);
      channel.unbind('pusher:subscription_succeeded', onSubscription);
      channel.unbind('pusher:subscription_error');
      client.unsubscribe(channelName);
    };
  }, [pusherClient, currentGame?.id, currentGame?.localOnly, currentGame?.status, notify]);

  useEffect(() => {
    if (runtime !== 'live' || !profile || locked) setOnlinePublicIds(new Set());
  }, [runtime, profile?.id, locked]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, []);

  const updateGame = useCallback((game: GameRecord) => {
    const next = { ...game, updated_at: new Date().toISOString() };
    currentGameRef.current = next;
    setCurrentGame(next);
    setGames((previous) => upsertGame(previous, next));
    return next;
  }, []);

  const sendGameSnapshot = useCallback((game: GameRecord) => {
    const channel = pusherRef.current?.channel(`private-game-${game.id}`);
    if (!channel?.subscribed) return false;
    const payload = { fromId: profileRef.current?.id, game: encodeGameSnapshot(game) };
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 9_000) return false;
    return channel.trigger('client-game-update', payload);
  }, []);

  const finishGame = useCallback((status: GameRecord['status'], winnerId: string | null, reason: string) => {
    const game = currentGameRef.current;
    if (!game || game.status !== 'active') return;
    const clockValues = clocksFor(game, Date.now());
    const finished: GameRecord = {
      ...game, status, winner_id: winnerId, result_reason: reason, finished_at: new Date().toISOString(),
      turn_started_at: null, turn_user_id: null, white_clock_ms: clockValues.white, black_clock_ms: clockValues.black,
      version: game.version + 1, updated_at: new Date().toISOString(),
    };
    updateGame(finished);
    if (!game.localOnly) sendGameSnapshot(finished);
    notify(status === 'checkmate' ? 'Checkmate. The game is over.' : status === 'draw' ? 'The game ended in a draw.' : 'Game finished.', 'success');
  }, [notify, sendGameSnapshot, updateGame]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const game = currentGameRef.current;
      if (!game || game.status !== 'active') return;
      const clocks = clocksFor(game, Date.now());
      if (Math.min(clocks.white, clocks.black) > 0) return;
      const flaggedId = game.turn_user_id;
      if (!flaggedId) return;
      if (game.localOnly || flaggedId === profileRef.current?.id) {
        const winnerId = flaggedId === game.white_id ? game.black_id : game.white_id;
        finishGame('timeout', winnerId, 'time_expired');
      }
    }, 300);
    return () => window.clearInterval(id);
  }, [finishGame]);

  useEffect(() => {
    const game = currentGame;
    if (!game || game.status !== 'active' || game.localOnly || game.turn_user_id !== profile?.id || !queuedPremove) return;
    const premove = queuedPremove;
    setQueuedPremove(null);
    const id = window.setTimeout(() => commitMove(premove.from, premove.to, premove.promotion || 'q'), 40);
    return () => window.clearTimeout(id);
    // commitMove intentionally reads the latest game snapshot through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGame?.turn_user_id, currentGame?.version, profile?.id, queuedPremove]);

  const saveGameLocally = useCallback((game: GameRecord) => {
    currentGameRef.current = game;
    setCurrentGame(game);
    setGames((previous) => upsertGame(previous, game));
  }, []);

  function commitMove(from: string, to: string, selectedPromotion?: string) {
    const game = currentGameRef.current;
    const player = profileRef.current;
    if (!game || !player || game.status !== 'active') return;
    const localColor = game.white_id === player.id ? 'w' : 'b';
    const currentColor = game.turn_user_id === game.white_id ? 'w' : 'b';
    if (!game.localOnly && game.turn_user_id !== player.id) {
      const targets = legalTargetsFor(game.fen, from, localColor);
      if (!targets.includes(to as Square)) { notify('That is not a legal premove.', 'info'); return; }
      setQueuedPremove({ from, to, promotion: selectedPromotion });
      setSelectedSquare(null); setLegalTargets([]);
      return;
    }
    const chess = safeChess(game);
    if (chess.turn() !== currentColor) return;
    let played;
    try {
      const choices = chess.moves({ square: from as Square, verbose: true }).filter((move) => move.to === to);
      if (!choices.length) { notify('That move is not legal.', 'info'); return; }
      const hasPromotion = choices.some((move) => Boolean(move.promotion));
      if (hasPromotion && !selectedPromotion) { setPromotion({ from, to }); return; }
      played = chess.move({ from, to, ...(hasPromotion ? { promotion: selectedPromotion || 'q' } : {}) });
    } catch { notify('That move could not be applied.', 'error'); return; }
    if (!played) return;
    const clocks = clocksFor(game, Date.now());
    let whiteClock = clocks.white;
    let blackClock = clocks.black;
    if (game.turn_user_id === game.white_id) whiteClock += game.increment_seconds * 1000;
    else blackClock += game.increment_seconds * 1000;
    const nextTurn = chess.turn() === 'w' ? game.white_id : game.black_id;
    const mate = chess.isCheckmate();
    const stalemate = chess.isStalemate();
    const draw = chess.isDraw();
    const status: GameRecord['status'] = mate ? 'checkmate' : stalemate ? 'stalemate' : draw ? 'draw' : 'active';
    const nowIso = new Date().toISOString();
    const move: GameMove = {
      from_square: played.from, to_square: played.to, promotion: played.promotion || null, san: played.san,
      fen_after: chess.fen(), pgn_after: chess.pgn(), white_clock_ms: whiteClock, black_clock_ms: blackClock,
      turn_user_id: status === 'active' ? nextTurn : null, created_at: nowIso,
    } as GameMove;
    const updated: GameRecord = {
      ...game, fen: chess.fen(), pgn: chess.pgn(), turn_user_id: status === 'active' ? nextTurn : null,
      white_clock_ms: whiteClock, black_clock_ms: blackClock, turn_started_at: status === 'active' ? nowIso : null,
      started_at: game.started_at || nowIso, finished_at: status === 'active' ? null : nowIso,
      winner_id: mate ? game.turn_user_id : null,
      result_reason: mate ? 'checkmate' : stalemate ? 'stalemate' : draw ? 'draw' : null,
      moves_count: game.moves_count + 1, version: game.version + 1,
      last_move: { from: played.from, to: played.to, san: played.san },
      moves: [...(game.moves || []), move],
    };
    setSelectedSquare(null); setLegalTargets([]); setPromotion(null); setQueuedPremove(null);
    playMoveTone(preferencesRef.current.sound);
    updateGame(updated);
    if (!game.localOnly && !sendGameSnapshot(updated)) notify('Move saved on this device, but the relay is reconnecting. The board will sync when it returns.', 'error');
    if (status === 'checkmate') notify('Checkmate. Attack lines are marked on the board.', 'success');
    else if (status === 'stalemate' || status === 'draw') notify('The game ended in a draw.', 'info');
  }

  function handleSquareClick(square: string) {
    const game = currentGameRef.current;
    const player = profileRef.current;
    if (!game || !player || game.status !== 'active' || replayOpen) return;
    const localColor = game.localOnly ? (game.turn_user_id === game.white_id ? 'w' : 'b') : game.white_id === player.id ? 'w' : 'b';
    const remoteWaiting = !game.localOnly && game.turn_user_id !== player.id;
    if (selectedSquare && legalTargets.includes(square)) {
      commitMove(selectedSquare, square);
      return;
    }
    const chess = safeChess(game);
    const piece = chess.get(square as Square);
    if (piece && piece.color === localColor) {
      setSelectedSquare(square);
      setLegalTargets(legalTargetsFor(game.fen, square, remoteWaiting ? localColor : chess.turn()));
      return;
    }
    setSelectedSquare(null); setLegalTargets([]);
  }

  const startPractice = useCallback((time = selectedTime) => {
    const player = profileRef.current;
    if (!player) return;
    const localOpponentId = 'kc_00000000000000000000000000000000';
    const game = createGame(player.id, localOpponentId, time, 0, player.id, 'active', true);
    saveGameLocally(game);
    setKnownPlayers((current) => ({ ...current, [localOpponentId]: { id: localOpponentId, public_id: 'pu_00000000000000000000000000000000', friend_code: 'LOCAL', username: 'practice', display_name: 'Practice partner' } }));
    setActiveTab('play'); setActiveView('game'); setQueuedPremove(null); setReplayOpen(false); setSelectedSquare(null); setLegalTargets([]); setPromotion(null);
    notify('Local practice is ready. You can play both sides.', 'success');
  }, [notify, saveGameLocally, selectedTime]);

  const issueChallenge = useCallback(async (friend: FriendRecord, time = selectedTime) => {
    const player = profileRef.current;
    if (!player) return;
    if (!onlinePublicIds.has(friend.public_id)) { notify(`${friend.display_name} is offline. Challenges are only delivered live.`, 'error'); return; }
    const option = TIME_OPTIONS.find((item) => item.seconds === time) || TIME_OPTIONS[1];
    const game = createGame(player.id, friend.id, option.seconds, option.increment, player.id, 'pending', false);
    setKnownPlayers((current) => ({ ...current, [friend.id]: friend }));
    saveGameLocally(game); setActiveTab('play'); setActiveView('game'); setQueuedPremove(null); setRematchWaiting(false); setSelectedSquare(null); setLegalTargets([]); setPromotion(null);
    const sent = await sendRelayEvent(friend.id, 'challenge', { from: player, game });
    if (!sent) {
      const failed = { ...game, status: 'declined' as const, result_reason: 'relay_unavailable', finished_at: new Date().toISOString(), version: 1 };
      saveGameLocally(failed);
      notify('Could not deliver the challenge. Make sure realtime is connected and client events are enabled.', 'error');
      return;
    }
    notify(`Challenge sent to ${friend.display_name}.`, 'success');
  }, [notify, onlinePublicIds, saveGameLocally, selectedTime, sendRelayEvent]);

  async function addFriendByCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const player = profileRef.current;
    const targetId = parseFriendCode(friendCodeInput);
    if (!player || !targetId) { notify('Enter a valid KnightClub friend code.', 'error'); return; }
    if (targetId === player.id) { notify('That is your own friend code.', 'error'); return; }
    if (friendsRef.current.some((friend) => friend.id === targetId)) { notify('That player is already in your friends list.', 'info'); return; }
    const publicId = await publicIdFor(targetId);
    if (!onlinePublicIds.has(publicId)) { notify('They need to open KnightClub before you can send a friend request.', 'error'); return; }
    const from: PlayerProfile = { ...player, friend_code: makeFriendCode(player.id) };
    const requestId = `fr_${randomHex(12)}`;
    const sent = await sendRelayEvent(targetId, 'friend-request', { requestId, from });
    if (!sent) { notify('Could not deliver the request. Reconnect and try again.', 'error'); return; }
    setOutgoingFriendIds((current) => current.includes(targetId) ? current : [...current, targetId]);
    setKnownPlayers((current) => ({ ...current, [targetId]: { id: targetId, public_id: publicId, friend_code: makeFriendCode(targetId), username: 'new-player', display_name: 'KnightClub player' } }));
    setFriendCodeInput('');
    notify('Friend request sent. They need to accept while online.', 'success');
  }

  async function acceptFriendRequest(request: FriendRequest) {
    const player = profileRef.current;
    if (!player) return;
    if (!onlinePublicIds.has(request.other_player.public_id)) { notify('They went offline. Requests are not stored for later; try again when they are online.', 'error'); return; }
    addFriendLocally(request.other_player);
    const sent = await sendRelayEvent(request.other_player.id, 'friend-accepted', { requestId: request.id, friend: player });
    setFriendRequests((current) => current.filter((item) => item.id !== request.id));
    notify(sent ? `${request.other_player.display_name} added to your friends.` : 'Added locally; the other player may need to resend because they disconnected.', sent ? 'success' : 'info');
  }

  async function declineFriendRequest(request: FriendRequest) {
    const sent = await sendRelayEvent(request.other_player.id, 'friend-declined', { requestId: request.id, fromId: profileRef.current?.id });
    setFriendRequests((current) => current.filter((item) => item.id !== request.id));
    notify(sent ? 'Friend request declined.' : 'Request removed from this browser.', 'info');
  }

  async function acceptChallenge(challenge: PendingChallenge) {
    const player = profileRef.current;
    if (!player) return;
    const nowIso = new Date().toISOString();
    const game: GameRecord = { ...challenge.game, status: 'active', started_at: nowIso, turn_started_at: nowIso, turn_user_id: challenge.game.white_id, version: challenge.game.version + 1, updated_at: nowIso, localOnly: false };
    addFriendLocally(challenge.from);
    setIncomingChallenges((current) => current.filter((item) => item.id !== challenge.id));
    saveGameLocally(game); setActiveTab('play'); setActiveView('game'); setSelectedSquare(null); setLegalTargets([]); setPromotion(null); setQueuedPremove(null);
    const sent = await sendRelayEvent(challenge.from.id, 'challenge-answer', { gameId: challenge.id, accepted: true, game });
    notify(sent ? 'Game started. White moves first.' : 'Game started here, but your opponent may have disconnected before receiving the answer.', sent ? 'success' : 'info');
  }

  async function declineChallenge(challenge: PendingChallenge) {
    const sent = await sendRelayEvent(challenge.from.id, 'challenge-answer', { gameId: challenge.id, accepted: false });
    setIncomingChallenges((current) => current.filter((item) => item.id !== challenge.id));
    notify(sent ? 'Challenge declined.' : 'Challenge removed from this browser.', 'info');
  }

  function offerGameAction(type: GameActionType) {
    const game = currentGameRef.current;
    const player = profileRef.current;
    if (!game || !player || game.status !== 'active') return;
    if (game.localOnly) { notify('Takebacks and draw offers are for online matches. You can restart the local board at any time.', 'info'); return; }
    const recipientId = game.white_id === player.id ? game.black_id : game.white_id;
    const action: GameAction = { id: `act_${randomHex(10)}`, game_id: game.id, requester_id: player.id, recipient_id: recipientId, type, status: 'pending', game_version: game.version, created_at: new Date().toISOString(), other_player: knownPlayers[recipientId] };
    const updated = updateGame({ ...game, actions: [...(game.actions || []).filter((item) => item.status !== 'pending'), action], version: game.version + 1 });
    if (!sendGameSnapshot(updated)) notify('The offer could not be sent while the relay is disconnected.', 'error');
    else notify(type === 'draw' ? 'Draw offer sent.' : 'Takeback request sent.', 'success');
  }

  function respondToGameAction(actionId: string, accepted: boolean) {
    const game = currentGameRef.current;
    const player = profileRef.current;
    if (!game || !player) return;
    const action = (game.actions || []).find((item) => item.id === actionId);
    if (!action) return;
    let updated: GameRecord = { ...game, actions: (game.actions || []).map((item) => item.id === actionId ? { ...item, status: accepted ? 'accepted' : 'rejected' } : item), version: game.version + 1 };
    if (accepted && action.type === 'draw') {
      updated = { ...updated, status: 'draw', result_reason: 'agreed_draw', winner_id: null, finished_at: new Date().toISOString(), turn_started_at: null, turn_user_id: null };
    }
    if (accepted && action.type === 'takeback') {
      const moves = allMoves(game).slice(0, -1);
      const chess = new Chess();
      for (const move of moves) chess.move({ from: move.from_square, to: move.to_square, ...(move.promotion ? { promotion: move.promotion } : {}) });
      const previousMove = moves[moves.length - 1] as (GameMove & { white_clock_ms?: number; black_clock_ms?: number }) | undefined;
      const nowIso = new Date().toISOString();
      updated = {
        ...updated, status: 'active', fen: chess.fen(), pgn: chess.pgn(), moves, moves_count: moves.length,
        last_move: moves.length ? { from: moves[moves.length - 1].from_square, to: moves[moves.length - 1].to_square, san: moves[moves.length - 1].san } : null,
        turn_user_id: chess.turn() === 'w' ? game.white_id : game.black_id, turn_started_at: nowIso, finished_at: null, winner_id: null, result_reason: null,
        white_clock_ms: previousMove?.white_clock_ms ?? game.time_control_seconds * 1000,
        black_clock_ms: previousMove?.black_clock_ms ?? game.time_control_seconds * 1000,
      };
    }
    updateGame(updated);
    if (!sendGameSnapshot(updated)) notify('Could not send the response. Reconnect and try again.', 'error');
    else notify(accepted ? `${action.type === 'draw' ? 'Draw' : 'Takeback'} accepted.` : 'Offer declined.', 'success');
  }

  function requestRematch() {
    const game = currentGameRef.current;
    const player = profileRef.current;
    if (!game || !player || game.localOnly) {
      if (game?.localOnly) startPractice(game.time_control_seconds);
      return;
    }
    const next = createGame(game.black_id, game.white_id, game.time_control_seconds, game.increment_seconds, player.id, 'pending', false);
    setRematchWaiting(true);
    const channel = pusherRef.current?.channel(`private-game-${game.id}`);
    const sent = Boolean(channel?.subscribed && channel.trigger('client-rematch-request', { fromId: player.id, game: next }));
    if (!sent) { setRematchWaiting(false); notify('Could not send the rematch request.', 'error'); }
    else notify('Rematch request sent. Colors will switch.', 'success');
  }

  function answerRematch(accepted: boolean) {
    const request = rematchIncoming;
    const oldGame = currentGameRef.current;
    const player = profileRef.current;
    if (!request || !oldGame || !player) return;
    setRematchIncoming(null);
    const channel = pusherRef.current?.channel(`private-game-${oldGame.id}`);
    if (!accepted) {
      channel?.trigger('client-rematch-answer', { gameId: oldGame.id, accepted: false });
      notify('Rematch declined.', 'info'); return;
    }
    const nowIso = new Date().toISOString();
    const next = { ...request.game, status: 'active' as const, started_at: nowIso, turn_started_at: nowIso, turn_user_id: request.game.white_id, version: request.game.version + 1, updated_at: nowIso };
    saveGameLocally(next); setActiveTab('play'); setActiveView('game');
    channel?.trigger('client-rematch-answer', { gameId: oldGame.id, accepted: true, game: next });
    notify('Rematch started. White moves first.', 'success');
  }

  function saveDisplayName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    const name = displayNameInput.trim().slice(0, 32);
    if (name.length < 2) { notify('Choose a name with at least two characters.', 'error'); return; }
    setProfile({ ...profile, display_name: name });
    notify('Display name saved on this browser.', 'success');
  }

  async function saveDeviceLock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (deviceLock) {
      const candidate = await makePasswordHash(lockCurrentInput, deviceLock.salt);
      if (candidate !== deviceLock.hash) { notify('Current local lock password is incorrect.', 'error'); return; }
    }
    if (!lockNewInput) {
      if (!deviceLock) { notify('Enter a new password to create a local lock.', 'error'); return; }
      setDeviceLock(null); setLocked(false); localStorage.removeItem(LOCK_KEY);
      setLockCurrentInput(''); setLockNewInput(''); setLockConfirmInput('');
      notify('Local lock removed from this browser.', 'success'); return;
    }
    if (lockNewInput.length < 8) { notify('Use at least 8 characters for the local lock.', 'error'); return; }
    if (lockNewInput !== lockConfirmInput) { notify('The new passwords do not match.', 'error'); return; }
    const salt = randomHex(16);
    const lock = { salt, hash: await makePasswordHash(lockNewInput, salt) };
    setDeviceLock(lock); setLocked(false); localStorage.setItem(LOCK_KEY, JSON.stringify(lock));
    setLockCurrentInput(''); setLockNewInput(''); setLockConfirmInput('');
    notify('Local browser lock saved. It is not an account password.', 'success');
  }

  async function unlockApp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deviceLock) { setLocked(false); return; }
    const candidate = await makePasswordHash(unlockInput, deviceLock.salt);
    if (candidate !== deviceLock.hash) { notify('That local lock password is incorrect.', 'error'); return; }
    setLocked(false); setUnlockInput('');
  }

  async function copyFriendCode() {
    if (!profile) return;
    try { await navigator.clipboard.writeText(profile.friend_code); notify('Friend code copied. Share it once with a friend.', 'success'); }
    catch { notify(`Your friend code is ${profile.friend_code}`, 'info'); }
  }

  async function enableNotifications() {
    if (typeof Notification === 'undefined') { notify('This browser does not support notifications.', 'error'); return; }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission === 'granted') { setPreferences((value) => ({ ...value, notifications: true })); notify('Notifications enabled for this open browser session.', 'success'); }
    else { setPreferences((value) => ({ ...value, notifications: false })); notify('Browser notification permission was not granted.', 'info'); }
  }

  const filteredFriends = useMemo(() => friends.filter((friend) => friend.display_name.toLowerCase().includes(search.toLowerCase()) || friend.username.toLowerCase().includes(search.toLowerCase())), [friends, search]);
  const currentOpponentId = currentGame && profile ? (currentGame.white_id === profile.id ? currentGame.black_id : currentGame.white_id) : '';
  const opponent = currentOpponentId ? (friends.find((friend) => friend.id === currentOpponentId) || knownPlayers[currentOpponentId] || { id: currentOpponentId, public_id: '', friend_code: '', username: 'opponent', display_name: currentGame?.localOnly ? 'Practice partner' : 'KnightClub player' }) : null;
  const gameMoves = currentGame ? allMoves(currentGame) : [];
  const mate = mateInfo(currentGame);
  const boardFen = currentGame ? (replayOpen ? fenAfterMoves(gameMoves, replayIndex) : currentGame.fen) : INITIAL_FEN;
  const displayClocks = currentGame ? clocksFor(currentGame, now) : { white: 0, black: 0 };
  const isMyTurn = Boolean(currentGame && profile && currentGame.turn_user_id === profile.id);
  const gameColor = currentGame && profile ? (currentGame.white_id === profile.id ? 'w' : 'b') : 'w';
  const activeAction = currentGame?.actions?.find((action) => action.status === 'pending');
  const incomingForMe = activeAction?.recipient_id === profile?.id;
  const outgoingForMe = activeAction?.requester_id === profile?.id;

  if (runtime === 'loading') {
    return <main className="auth-screen"><div className="auth-card"><div className="brand-mark">♞</div><p className="eyebrow">KNIGHTCLUB</p><h1>Setting up your board…</h1><div className="auth-loading"><LoaderCircle size={16} className="spin" /> Loading this browser’s local profile</div></div></main>;
  }

  if (locked) {
    return <main className="auth-screen"><form className="auth-card" onSubmit={unlockApp}><div className="auth-brand"><span className="brand-mark">♞</span><span className="brand-copy"><strong>KnightClub</strong><small>CHESS WITH FRIENDS</small></span></div><div className="auth-heading"><span className="auth-heading-icon"><LockKeyhole size={18} /></span><span className="eyebrow">THIS BROWSER ONLY</span><h1>Welcome back.</h1><p>Enter the local lock for this device. There is no account or password recovery.</p></div><label className="auth-label">Local lock password<input type="password" value={unlockInput} onChange={(event) => setUnlockInput(event.target.value)} autoComplete="current-password" required autoFocus /></label><button className="button button-primary auth-submit" type="submit">Unlock KnightClub <ArrowRight size={14} /></button><div className="auth-footnote"><Shield size={13} /> Your profile and friends are stored only in this browser.</div></form>{toast && <Toast toast={toast} onClose={() => setToast(null)} />}</main>;
  }

  const setTab = (tab: Tab) => { setActiveTab(tab); setActiveView('lobby'); };
  const openGame = (game: GameRecord) => { setCurrentGame(game); currentGameRef.current = game; setActiveTab('play'); setActiveView('game'); setReplayOpen(false); };
  const getInitialTabTitle = () => ({ play: 'Play', friends: 'Friends', inbox: 'Inbox', history: 'Session games', settings: 'Settings' })[activeTab];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><span className="brand-mark">♞</span><span className="brand-copy"><strong>KnightClub</strong><small>CHESS WITH FRIENDS</small></span></div>
        <div className="sidebar-label">PLAY</div>
        <button className="new-game-button" onClick={() => startPractice()}><span className="new-game-icon"><Plus size={15} /></span><span>Practice locally</span><span className="new-game-hint">2 players</span></button>
        <nav className="side-nav" aria-label="Main navigation">
          <NavButton active={activeTab === 'play'} icon={<Play size={16} />} label="Play" onClick={() => setTab('play')} />
          <NavButton active={activeTab === 'friends'} icon={<UsersRound size={16} />} label="Friends" count={friends.length} onClick={() => setTab('friends')} />
          <NavButton active={activeTab === 'inbox'} icon={<Inbox size={16} />} label="Inbox" badge={incomingCount} onClick={() => setTab('inbox')} />
          <NavButton active={activeTab === 'history'} icon={<History size={16} />} label="Session games" onClick={() => setTab('history')} />
        </nav>
        <div className="sidebar-label sidebar-settings-label">PREFERENCES</div>
        <nav className="side-nav"><NavButton active={activeTab === 'settings'} icon={<Settings size={16} />} label="Settings" onClick={() => setTab('settings')} /></nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-live-card"><span className={connected ? 'live-dot' : 'live-dot live-dot-offline'} /><div><strong>{runtime === 'live' ? (connected ? 'Realtime connected' : 'Connecting to relay') : 'Local-only preview'}</strong><small>{runtime === 'live' ? 'Pusher Channels · no database' : 'Configure Pusher for online play'}</small></div>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}</div>
        {profile && <button className="account-row" onClick={() => setTab('settings')}><span className="avatar avatar-sidebar">{initials(profile.display_name)}</span><span className="account-meta"><strong>{profile.display_name}</strong><small>Browser profile</small></span><Settings size={14} /></button>}
        <div className="sidebar-demo-note">Friends & preferences stay on this device</div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb"><span>KnightClub</span><ChevronRight size={12} /><strong>{activeTab === 'play' && activeView === 'game' ? 'Game room' : getInitialTabTitle()}</strong></div>
          <div className="topbar-right"><span className={`connection-pill ${connected ? '' : 'connection-offline'}`}><i className="connection-dot" />{runtime === 'live' ? connectionState : 'Local mode'}</span><button className="icon-button topbar-bell" aria-label="Open inbox" onClick={() => setTab('inbox')}><Bell size={16} />{incomingCount > 0 && <i className="bell-dot" />}</button>{profile && <button className="topbar-profile" onClick={() => setTab('settings')}><span className="avatar avatar-top">{initials(profile.display_name)}</span><span>{profile.display_name}</span><ChevronDown size={13} /></button>}</div>
        </header>

        <section className="page-content">
          {activeTab === 'play' && activeView === 'game' && currentGame && profile ? (
            <GameRoom
              game={currentGame} player={profile} opponent={opponent!} boardFen={boardFen} mate={mate}
              theme={preferences.boardTheme} coordinates={preferences.coordinates} selectedSquare={selectedSquare}
              legalTargets={legalTargets} premove={queuedPremove} disabled={currentGame.status !== 'active' || replayOpen}
              replayOpen={replayOpen} replayIndex={replayIndex} replayTotal={gameMoves.length}
              clocks={displayClocks} isMyTurn={isMyTurn} gameColor={gameColor}
              activeAction={activeAction} incomingForMe={Boolean(incomingForMe)} outgoingForMe={Boolean(outgoingForMe)}
              rematchIncoming={rematchIncoming} rematchWaiting={rematchWaiting}
              onBack={() => { setActiveView('lobby'); setReplayOpen(false); }}
              onSquareClick={handleSquareClick} onMoveDrop={commitMove} onDragSelect={(square) => { setSelectedSquare(square); if (currentGame.status === 'active') { const activeColor = currentGame.localOnly ? new Chess(currentGame.fen).turn() : gameColor; setLegalTargets(legalTargetsFor(currentGame.fen, square, activeColor)); } }}
              onCancelPremove={() => { setQueuedPremove(null); setSelectedSquare(null); setLegalTargets([]); }}
              onPromotion={(piece) => { if (promotion) commitMove(promotion.from, promotion.to, piece); }}
              promotion={promotion} onCancelPromotion={() => setPromotion(null)}
              onResign={() => { setResignConfirm(false); finishGame('resigned', currentGame.white_id === profile.id ? currentGame.black_id : currentGame.white_id, 'resignation'); }}
              resignConfirm={resignConfirm} onToggleResign={() => setResignConfirm((value) => !value)}
              onOfferDraw={() => offerGameAction('draw')} onTakeback={() => offerGameAction('takeback')}
              onRespondAction={respondToGameAction} onRematch={requestRematch} onAnswerRematch={answerRematch}
              onReplay={() => { setReplayOpen(true); setReplayIndex(0); }} onReplayIndex={setReplayIndex} onCloseReplay={() => setReplayOpen(false)}
              onNewGame={() => startPractice(currentGame.time_control_seconds)}
            />
          ) : activeTab === 'play' ? (
            <Dashboard
              profile={profile} runtime={runtime} connected={connected} friends={friends} onlinePublicIds={onlinePublicIds}
              incomingChallenges={incomingChallenges} games={games} currentGame={currentGame} selectedTime={selectedTime}
              onSetTime={setSelectedTime} onStartPractice={() => startPractice()} onResume={openGame}
              onOpenFriends={() => setTab('friends')} onOpenInbox={() => setTab('inbox')} onOpenHistory={() => setTab('history')}
              onAcceptChallenge={acceptChallenge} onChallenge={issueChallenge}
            />
          ) : activeTab === 'friends' ? (
            <FriendsPage profile={profile} friends={filteredFriends} allCount={friends.length} onlineCount={onlineFriendCount} search={search} onSearch={setSearch}
              friendCodeInput={friendCodeInput} onFriendCodeChange={setFriendCodeInput} onAddFriend={addFriendByCode} onCopyCode={copyFriendCode}
              outgoingIds={outgoingFriendIds} onChallenge={issueChallenge} runtime={runtime} onGoSettings={() => setTab('settings')}
              requests={friendRequests} onAccept={acceptFriendRequest} onDecline={declineFriendRequest} />
          ) : activeTab === 'inbox' ? (
            <InboxPage challenges={incomingChallenges} friendRequests={friendRequests.filter((request) => request.direction === 'incoming')}
              outgoingIds={outgoingFriendIds} onlineIds={onlinePublicIds} knownPlayers={knownPlayers}
              onAcceptChallenge={acceptChallenge} onDeclineChallenge={declineChallenge} onAcceptFriend={acceptFriendRequest} onDeclineFriend={declineFriendRequest}
              onGoFriends={() => setTab('friends')} runtime={runtime} />
          ) : activeTab === 'history' ? (
            <HistoryPage games={games} player={profile} knownPlayers={knownPlayers} onOpenGame={openGame} onPractice={() => startPractice()} />
          ) : (
            <SettingsPage profile={profile} runtime={runtime} connected={connected} preferences={preferences} onPreferences={setPreferences}
              onSaveName={saveDisplayName} displayName={displayNameInput} onDisplayName={setDisplayNameInput} onCopyCode={copyFriendCode}
              deviceLock={deviceLock} currentPassword={lockCurrentInput} newPassword={lockNewInput} confirmPassword={lockConfirmInput}
              onCurrentPassword={setLockCurrentInput} onNewPassword={setLockNewInput} onConfirmPassword={setLockConfirmInput}
              onSaveLock={saveDeviceLock} onEnableNotifications={enableNotifications} />
          )}
        </section>
        <footer className="app-footer"><span>♞</span> KnightClub <i>·</i> Live relay, no database, no saved online match history</footer>
      </div>

      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </main>
  );
}

function upsertGame(games: GameRecord[], game: GameRecord) {
  return [game, ...games.filter((item) => item.id !== game.id)].slice(0, 30);
}

function NavButton({ active, icon, label, count, badge, onClick }: { active: boolean; icon: React.ReactNode; label: string; count?: number; badge?: number; onClick: () => void }) {
  return <button className={`nav-link${active ? ' nav-active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{badge ? <span className="nav-badge">{badge}</span> : count !== undefined ? <span className="nav-count">{count}</span> : null}<ChevronRight className="nav-chevron" size={13} /></button>;
}

function Dashboard({ profile, runtime, connected, friends, onlinePublicIds, incomingChallenges, games, currentGame, selectedTime, onSetTime, onStartPractice, onResume, onOpenFriends, onOpenInbox, onOpenHistory, onAcceptChallenge, onChallenge }: {
  profile: PlayerProfile | null; runtime: Runtime; connected: boolean; friends: FriendRecord[]; onlinePublicIds: Set<string>;
  incomingChallenges: PendingChallenge[]; games: GameRecord[]; currentGame: GameRecord | null; selectedTime: number;
  onSetTime: (time: number) => void; onStartPractice: () => void; onResume: (game: GameRecord) => void;
  onOpenFriends: () => void; onOpenInbox: () => void; onOpenHistory: () => void;
  onAcceptChallenge: (challenge: PendingChallenge) => void; onChallenge: (friend: FriendRecord) => void;
}) {
  const activeGame = currentGame?.status === 'active' ? currentGame : null;
  const onlineFriends = friends.filter((friend) => onlinePublicIds.has(friend.public_id));
  return <>
    <div className="page-heading-row"><div><span className="eyebrow">YOUR PRIVATE CHESS CLUB</span><h1>Good to see you, {profile?.display_name.split(' ')[0] || 'player'}.</h1><p className="muted">Settle in for a thoughtful game, right here in your browser.</p></div><button className="button button-outline" onClick={onOpenFriends}><UserPlus size={14} /> Add a friend</button></div>
    {runtime === 'local' && <div className="preview-notice"><AlertTriangle size={15} /><span><strong>Local preview.</strong> The board works now; online challenges need Pusher credentials. No database is used.</span><button onClick={onOpenFriends}>Setup guide <ChevronRight size={12} /></button></div>}
    {!connected && runtime === 'live' && <div className="preview-notice"><WifiOff size={15} /><span><strong>Relay reconnecting.</strong> Friend requests and game moves need both browsers online.</span></div>}
    <div className="home-grid">
      <div className="home-main-column">
        <section className="hero-card"><div className="hero-content"><div className="hero-kicker"><span className="hero-sparkle">✦</span> YOUR NEXT GAME STARTS HERE</div><h2>A good game is<br />better with friends.</h2><p>Invite someone you know. No accounts, no database—just your board, their board, and a live relay.</p><div className="hero-actions"><button className="button button-cream" onClick={onStartPractice}><Play size={14} /> Practice locally</button><button className="hero-text-button" onClick={onOpenFriends}>Set up friends <ArrowRight size={13} /></button></div></div><div className="hero-art"><span className="hero-orbit orbit-one" /><span className="hero-orbit orbit-two" /><span className="hero-chess-piece">♞</span><span className="hero-art-caption"><i className="hero-art-dot" />{connected ? 'RELAY ONLINE' : 'YOUR BOARD AWAITS'}</span><div className="hero-mini-board">{['♜','♞','♝','♛','♟','♟','♟','♟'].map((piece, index) => <span key={index}>{piece}</span>)}</div></div></section>
        {activeGame && <section><div className="section-heading"><div><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2>Game in progress</h2></div></div><div className="game-list-card"><button className="resume-row" onClick={() => onResume(activeGame)}><span className="game-avatar avatar-cream">♞</span><span className="resume-detail"><strong>vs {friends.find((friend) => friend.id === (activeGame.white_id === profile?.id ? activeGame.black_id : activeGame.white_id))?.display_name || 'your opponent'}</strong><small>{timeControlLabel(activeGame)} · {activeGame.moves_count} half-moves · {activeGame.localOnly ? 'local practice' : 'live game'}</small></span><span className="resume-state resume-incoming"><i className="status-dot status-active" /> Resume <ChevronRight size={13} /></span></button></div></section>}
        <section className="home-bottom-grid"><div className="small-stat-card"><span className="stat-icon stat-green"><UsersRound size={15} /></span><div><small>FRIENDS ONLINE</small><strong>{onlineFriends.length}</strong></div><button className="stat-link" onClick={onOpenFriends}>Open list <ArrowRight size={12} /></button></div><div className="small-stat-card"><span className="stat-icon stat-gold"><History size={15} /></span><div><small>THIS SESSION</small><strong>{games.length}</strong></div><button className="stat-link" onClick={onOpenHistory}>View <ArrowRight size={12} /></button></div></section>
        <div className="reliability-note"><Shield size={15} /><span><strong>Privacy by design.</strong> Friends and preferences stay in this browser. The relay forwards only live events; it does not keep an inbox or match history.</span></div>
      </div>
      <aside className="home-side-column">
        <section className="side-card"><div className="card-head"><div><span className="eyebrow">YOUR CIRCLE</span><h3><UsersRound size={14} /> Friends <span className="head-count">{friends.length}</span></h3></div><button className="icon-button small-icon" onClick={onOpenFriends} aria-label="Add a friend"><Plus size={14} /></button></div>
          {friends.length ? <div className="mini-friends-list">{friends.slice(0, 4).map((friend) => { const online = onlinePublicIds.has(friend.public_id); return <div className="mini-friend-row" key={friend.id}><span className="avatar friend-avatar">{initials(friend.display_name)}<i className={online ? 'presence-presence-online' : 'presence-presence-offline'} /></span><span className="mini-friend-name"><strong>{friend.display_name}</strong><small>{online ? 'Online now' : 'Offline'}</small></span><button className="mini-challenge" title={online ? 'Challenge' : 'Friend must be online'} disabled={!online} onClick={() => onChallenge(friend)}><Swords size={13} /></button></div>; })}</div> : <div className="side-empty"><UserPlus size={16} /><span>Friends you add on this device will appear here.</span></div>}
          <button className="card-footer-link" onClick={onOpenFriends}>Manage friends <ArrowRight size={12} /></button>
        </section>
        <section className="side-card"><div className="card-head"><div><span className="eyebrow">LIVE REQUESTS</span><h3><span className="inbox-icon"><Inbox size={14} /></span> Inbox <span className="head-count">{incomingChallenges.length}</span></h3></div><button className="icon-button small-icon" onClick={onOpenInbox} aria-label="Open inbox"><ArrowRight size={14} /></button></div>
          {incomingChallenges.length ? incomingChallenges.slice(0, 2).map((challenge) => <div className="inbox-preview" key={challenge.id}><i className="inbox-preview-dot" /><span><strong>{challenge.from.display_name} challenged you</strong><small>{timeControlLabel(challenge.game)} · live request</small></span><button className="button button-soft button-compact" onClick={() => onAcceptChallenge(challenge)}>Accept</button></div>) : <div className="inbox-clear"><CheckCircleTiny />No live requests right now.</div>}
          <button className="card-footer-link" onClick={onOpenInbox}>Open inbox <ArrowRight size={12} /></button>
        </section>
        <label className="quick-time-control"><span><Timer size={13} /> Quick game time</span><select value={selectedTime} onChange={(event) => onSetTime(Number(event.target.value))}>{TIME_OPTIONS.map((option) => <option key={option.seconds} value={option.seconds}>{option.label}</option>)}</select></label>
      </aside>
    </div>
  </>;
}

function CheckCircleTiny() { return <CheckCheck size={15} />; }

function FriendsPage({ profile, friends, allCount, onlineCount, search, onSearch, friendCodeInput, onFriendCodeChange, onAddFriend, onCopyCode, outgoingIds, onChallenge, runtime, onGoSettings, requests, onAccept, onDecline }: {
  profile: PlayerProfile | null; friends: FriendRecord[]; allCount: number; onlineCount: number; search: string; onSearch: (value: string) => void;
  friendCodeInput: string; onFriendCodeChange: (value: string) => void; onAddFriend: (event: FormEvent<HTMLFormElement>) => void; onCopyCode: () => void;
  outgoingIds: string[]; onChallenge: (friend: FriendRecord) => void; runtime: Runtime; onGoSettings: () => void;
  requests: FriendRequest[]; onAccept: (request: FriendRequest) => void; onDecline: (request: FriendRequest) => void;
}) {
  const incoming = requests.filter((request) => request.direction === 'incoming');
  return <>
    <div className="page-heading-row friends-heading"><div><span className="eyebrow">YOUR PEOPLE</span><h1>Friends</h1><p className="muted">Exchange a one-time friend code, then challenge each other in-app.</p></div><span className="friends-count-large"><UsersRound size={14} /> {allCount} saved <span className="presence-presence-online" style={{ position: 'static' }} /> {onlineCount} online</span></div>
    <div className="friends-layout"><section className="friends-main-panel"><div className="panel-heading"><div><span className="eyebrow">LOCAL FRIEND LIST</span><h2>Your friends</h2></div><span className="online-summary"><i className="presence-presence-online" /> {onlineCount} online</span></div>
      <div className="friends-filter-row"><label className="friend-search-field"><Search size={13} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search your friends" /></label><span className="friend-filter-total">{allCount} total</span></div>
      {friends.length ? <div className="friends-full-list">{friends.map((friend) => <div className="friend-full-row" key={friend.id}><span className="avatar friend-full-avatar">{initials(friend.display_name)}<i className={friend.online ? 'presence-presence-online' : 'presence-presence-offline'} /></span><span className="friend-full-info"><strong>{friend.display_name}</strong><small>{friend.online ? 'Online now' : 'Offline'} <span>·</span> {friend.username}</small></span><span className={friend.online ? 'friend-online-state' : 'friend-offline-state'}>{friend.online ? 'Online' : 'Offline'}</span><button className="button button-soft challenge-button" disabled={!friend.online} onClick={() => onChallenge(friend)}><Swords size={12} /> Challenge</button></div>)}</div> : <div className="empty-state-panel"><span className="empty-icon"><UsersRound size={20} /></span><h3>{search ? 'No matches' : 'Your circle starts here'}</h3><p>{search ? 'Try a different name.' : 'Add a friend with their code. Both of you need KnightClub open to exchange requests.'}</p><button className="button button-soft" onClick={onGoSettings}><KeyRound size={13} /> Find your friend code</button></div>}
      {incoming.length > 0 && <div className="pending-friends-section"><div className="panel-subhead"><h3>Friend requests</h3><span>{incoming.length}</span></div>{incoming.map((request) => <div className="pending-friend-row" key={request.id}><span className="avatar mini-pending-avatar">{initials(request.other_player.display_name)}</span><span><strong>{request.other_player.display_name}</strong><small>Wants to connect live</small></span><button className="button button-soft button-compact" onClick={() => onAccept(request)}><Check size={12} /> Accept</button><button className="icon-button action-decline" aria-label="Decline request" onClick={() => onDecline(request)}><X size={13} /></button></div>)}</div>}
    </section>
    <aside className="add-friend-card"><div className="add-friend-illustration"><UserPlus size={20} /><span className="add-friend-spark">✦</span></div><span className="eyebrow">PAIR ONCE · PLAY ANYTIME</span><h2>Bring your people to the board.</h2><p>Your friend code is a private invite. Share it once; after you both accept, friends are saved on each device.</p><form className="add-friend-form" onSubmit={onAddFriend}><label htmlFor="friend-code-input">Friend’s one-time code</label><div className="input-with-prefix"><span>KC-</span><input id="friend-code-input" value={friendCodeInput} onChange={(event) => onFriendCodeChange(event.target.value)} placeholder="paste code" autoComplete="off" /></div><button className="button button-primary" type="submit" disabled={runtime !== 'live'}><Send size={13} /> Send live request</button></form><div className="privacy-footnote"><Shield size={13} /><span>Both players must be online. Requests are not queued for later.</span></div><div className="sample-friend-note"><i className="sample-dot" />{outgoingIds.length ? `${outgoingIds.length} request${outgoingIds.length === 1 ? '' : 's'} sent this session` : 'No game links, no repeated invites.'}</div>
      {profile && <div className="your-code-panel"><div><small>YOUR FRIEND CODE</small><strong>{profile.friend_code}</strong></div><button className="icon-button" onClick={onCopyCode} aria-label="Copy your friend code"><Copy size={14} /></button></div>}
    </aside></div>
  </>;
}

function InboxPage({ challenges, friendRequests, outgoingIds, onlineIds, knownPlayers, onAcceptChallenge, onDeclineChallenge, onAcceptFriend, onDeclineFriend, onGoFriends, runtime }: {
  challenges: PendingChallenge[]; friendRequests: FriendRequest[]; outgoingIds: string[]; onlineIds: Set<string>; knownPlayers: Record<string, PlayerProfile>;
  onAcceptChallenge: (challenge: PendingChallenge) => void; onDeclineChallenge: (challenge: PendingChallenge) => void;
  onAcceptFriend: (request: FriendRequest) => void; onDeclineFriend: (request: FriendRequest) => void; onGoFriends: () => void; runtime: Runtime;
}) {
  const total = challenges.length + friendRequests.length;
  return <><div className="page-heading-row"><div><span className="eyebrow">LIVE ONLY · NO STORED INBOX</span><h1>Inbox</h1><p className="muted">Requests arrive only while both players have KnightClub open.</p></div><span className="inbox-total-pill"><Inbox size={13} /> {total} live request{total === 1 ? '' : 's'}</span></div>
    {runtime === 'local' && <div className="preview-notice"><Radio size={15} /><span><strong>Live relay not configured.</strong> Add Pusher credentials to exchange friend requests and challenges.</span></div>}
    <div className="inbox-sections"><section className="inbox-section"><div className="inbox-section-heading"><span className="inbox-section-icon icon-challenge"><Swords size={15} /></span><div><h2>Game challenges</h2><p>Time-limited, direct invitations from friends who are online.</p></div><span className="section-number">{challenges.length}</span></div>
      {challenges.length ? <div className="request-list">{challenges.map((challenge) => { const online = onlineIds.has(challenge.from.public_id); return <div className="request-card" key={challenge.id}><span className="avatar request-avatar">{initials(challenge.from.display_name)}</span><span className="request-main"><strong>{challenge.from.display_name} challenged you</strong><small>{timeControlLabel(challenge.game)} · {online ? 'online now' : 'sender may have disconnected'}</small></span><button className="button button-primary button-compact" onClick={() => onAcceptChallenge(challenge)}><Check size={12} /> Accept</button><button className="icon-button action-decline" aria-label="Decline challenge" onClick={() => onDeclineChallenge(challenge)}><X size={13} /></button></div>; })}</div> : <div className="inbox-empty-state"><span className="empty-icon"><Swords size={18} /></span><div><strong>No live challenges</strong><p>When a friend challenges you while you’re online, it will show up here.</p></div></div>}
    </section><section className="inbox-section"><div className="inbox-section-heading"><span className="inbox-section-icon icon-friend"><UserPlus size={15} /></span><div><h2>Friend requests</h2><p>One-time pairing requests. Accepted friends stay in this browser.</p></div><span className="section-number">{friendRequests.length}</span></div>
      {friendRequests.length ? <div className="request-list">{friendRequests.map((request) => { const online = onlineIds.has(request.other_player.public_id); return <div className="request-card" key={request.id}><span className="avatar request-avatar">{initials(request.other_player.display_name)}</span><span className="request-main"><strong>{request.other_player.display_name} wants to connect</strong><small>{online ? 'online now' : 'They may have gone offline'}</small></span><button className="button button-soft button-compact" onClick={() => onAcceptFriend(request)}><Check size={12} /> Accept</button><button className="icon-button action-decline" aria-label="Decline friend request" onClick={() => onDeclineFriend(request)}><X size={13} /></button></div>; })}</div> : <div className="inbox-empty-state"><span className="empty-icon"><UsersRound size={18} /></span><div><strong>No friend requests</strong><p>Share your code once, then connect while you’re both online.</p></div></div>}
    </section><section className="inbox-section"><div className="inbox-section-heading"><span className="inbox-section-icon icon-action"><Handshake size={15} /></span><div><h2>Outgoing requests</h2><p>Requests in this browser session that are awaiting a response.</p></div><span className="section-number">{outgoingIds.length}</span></div>{outgoingIds.length ? <div className="request-list">{outgoingIds.map((id) => <div className="request-card" key={id}><span className="avatar request-avatar">{initials(knownPlayers[id]?.display_name || 'Player')}</span><span className="request-main"><strong>{knownPlayers[id]?.display_name || 'KnightClub player'}</strong><small>Sent this session · no offline queue</small></span><span className="pending-label"><Clock3 size={12} /> Awaiting reply</span></div>)}</div> : <div className="inbox-empty-state"><span className="empty-icon"><CheckCheck size={18} /></span><div><strong>Nothing pending</strong><p>Outgoing requests are temporary; nothing waits in a durable inbox.</p></div></div>}</section></div>
    <div className="inbox-bottom-note"><Shield size={14} /><span>Requests are transient relay events. If someone is offline, no message is saved or delivered later.</span><button className="text-button" onClick={onGoFriends}>Go to friends <ArrowRight size={12} /></button></div>
  </>;
}

function HistoryPage({ games, player, knownPlayers, onOpenGame, onPractice }: { games: GameRecord[]; player: PlayerProfile | null; knownPlayers: Record<string, PlayerProfile>; onOpenGame: (game: GameRecord) => void; onPractice: () => void }) {
  return <><div className="page-heading-row"><div><span className="eyebrow">THIS BROWSER SESSION ONLY</span><h1>Session games</h1><p className="muted">Online matches are not saved as history. This list clears when you close the session.</p></div><button className="button button-primary" onClick={onPractice}><Play size={14} /> Practice locally</button></div>
    {games.length ? <div className="history-table-card"><div className="history-table-head"><span>OPPONENT</span><span>RESULT</span><span>TIME</span><span>TYPE</span><span /></div>{games.map((game) => { const otherId = player?.id === game.white_id ? game.black_id : game.white_id; const other = knownPlayers[otherId]; const result = game.status === 'active' ? 'In progress' : game.status === 'pending' ? 'Awaiting player' : statusLabel(game); const resultClass = game.status === 'active' ? 'result-live' : game.winner_id === player?.id ? 'result-won' : game.status === 'draw' || game.status === 'stalemate' ? 'result-draw' : game.winner_id ? 'result-lost' : ''; return <button className="history-row" key={game.id} onClick={() => onOpenGame(game)}><span className="history-opponent"><span className="avatar history-avatar">{initials(other?.display_name || 'Opponent')}</span><span><strong>{other?.display_name || (game.localOnly ? 'Practice partner' : 'KnightClub player')}</strong><small>{new Date(game.created_at).toLocaleString()}</small></span></span><span className={`history-result ${resultClass}`}><i />{result}</span><span className="history-time">{timeControlLabel(game)}</span><span className="history-date">{game.localOnly ? 'Local practice' : 'Live · temporary'}</span><ChevronRight className="history-chevron" size={14} /></button>; })}</div> : <div className="history-empty"><div className="empty-state-panel"><span className="empty-icon"><History size={20} /></span><h3>No games this session</h3><p>Start a local practice game or challenge a friend. Online match history is intentionally not stored.</p><button className="button button-primary" onClick={onPractice}><Play size={13} /> Start practice</button></div></div>}
  </>;
}

function SettingsPage({ profile, runtime, connected, preferences, onPreferences, onSaveName, displayName, onDisplayName, onCopyCode, deviceLock, currentPassword, newPassword, confirmPassword, onCurrentPassword, onNewPassword, onConfirmPassword, onSaveLock, onEnableNotifications }: {
  profile: PlayerProfile | null; runtime: Runtime; connected: boolean; preferences: LocalPreferences; onPreferences: (prefs: LocalPreferences | ((current: LocalPreferences) => LocalPreferences)) => void;
  onSaveName: (event: FormEvent<HTMLFormElement>) => void; displayName: string; onDisplayName: (name: string) => void; onCopyCode: () => void;
  deviceLock: DeviceLock | null; currentPassword: string; newPassword: string; confirmPassword: string;
  onCurrentPassword: (value: string) => void; onNewPassword: (value: string) => void; onConfirmPassword: (value: string) => void;
  onSaveLock: (event: FormEvent<HTMLFormElement>) => void; onEnableNotifications: () => void;
}) {
  return <><div className="page-heading-row"><div><span className="eyebrow">YOUR KNIGHTCLUB</span><h1>Settings</h1><p className="muted">Everything here stays in this browser unless it’s a live game event.</p></div><span className="connection-pill"><i className="connection-dot" />{connected ? 'Relay online' : runtime === 'live' ? 'Relay reconnecting' : 'Local-only mode'}</span></div>
    <div className="settings-layout"><div className="settings-main">
      <section className="settings-card"><div className="settings-card-heading"><span className="settings-icon"><UsersRound size={15} /></span><div><h2>Browser profile</h2><p>No account, email, or server-side profile.</p></div></div><form className="settings-form" onSubmit={onSaveName}><label><span>Display name</span><input value={displayName} onChange={(event) => onDisplayName(event.target.value)} maxLength={32} placeholder="How friends see you" /></label><label><span>Username</span><input value={profile?.username || ''} readOnly /></label><div className="settings-form-actions"><small>Saved to this device only.</small><button className="button button-primary button-compact" type="submit"><Check size={12} /> Save name</button></div></form><div className="your-friend-code"><div><small>YOUR ONE-TIME FRIEND CODE</small><strong>{profile?.friend_code}</strong><span>Share privately with someone you want to add.</span></div><button className="button button-outline button-compact" onClick={onCopyCode}><Copy size={12} /> Copy code</button></div></section>
      <section className="settings-card"><div className="settings-card-heading"><span className="settings-icon"><Settings size={15} /></span><div><h2>Board & sound</h2><p>These preferences are stored in local browser storage.</p></div></div><div className="setting-select-row"><span><strong>Board theme</strong><small>Choose a board palette</small></span><div className="theme-options"><button className={`theme-swatch${preferences.boardTheme === 'classic' ? ' theme-swatch-active' : ''}`} aria-label="Classic board" onClick={() => onPreferences((current) => ({ ...current, boardTheme: 'classic' }))}><i /></button><button className={`theme-swatch theme-swatch-wood${preferences.boardTheme === 'wood' ? ' theme-swatch-active' : ''}`} aria-label="Wood board" onClick={() => onPreferences((current) => ({ ...current, boardTheme: 'wood' }))}><i /></button><button className={`theme-swatch theme-swatch-slate${preferences.boardTheme === 'slate' ? ' theme-swatch-active' : ''}`} aria-label="Slate board" onClick={() => onPreferences((current) => ({ ...current, boardTheme: 'slate' }))}><i /></button></div></div><SettingToggle title="Board coordinates" detail="Show file and rank labels around the board" checked={preferences.coordinates} onChange={() => onPreferences((current) => ({ ...current, coordinates: !current.coordinates }))} /><SettingToggle title="Move sounds" detail="Play a short tone after a move" checked={preferences.sound} onChange={() => onPreferences((current) => ({ ...current, sound: !current.sound }))} /></section>
      <section className="settings-card"><div className="settings-card-heading"><span className="settings-icon"><Bell size={15} /></span><div><h2>Notifications</h2><p>Browser notifications work only while this page is open and connected.</p></div></div><SettingToggle title="Incoming challenges" detail="Ask the browser for permission to show live challenge alerts" checked={preferences.notifications} onChange={() => preferences.notifications ? onPreferences((current) => ({ ...current, notifications: false })) : onEnableNotifications()} /><div className="settings-note"><AlertTriangle size={13} />This is not offline push. No service stores or queues notifications while you are away.</div></section>
      <section className="settings-card"><div className="settings-card-heading"><span className="settings-icon"><LockKeyhole size={15} /></span><div><h2>Local device lock</h2><p>Optional browser-only lock; it is not an account password.</p></div></div><form className="password-form" onSubmit={onSaveLock}>{deviceLock && <label className="local-password-field"><span className="field-label">Current local lock</span><input type="password" value={currentPassword} onChange={(event) => onCurrentPassword(event.target.value)} autoComplete="current-password" /></label>}<div className="local-lock-grid"><label className="local-password-field"><span className="field-label">{deviceLock ? 'New password (blank removes lock)' : 'New local password'}</span><input type="password" value={newPassword} onChange={(event) => onNewPassword(event.target.value)} autoComplete="new-password" placeholder="At least 8 characters" /></label><label className="local-password-field"><span className="field-label">Confirm password</span><input type="password" value={confirmPassword} onChange={(event) => onConfirmPassword(event.target.value)} autoComplete="new-password" /></label></div><div className="settings-form-actions"><small>Clearing browser data removes this lock and local profile.</small><button className="button button-outline button-compact" type="submit"><KeyRound size={12} /> {deviceLock ? 'Update local lock' : 'Set local lock'}</button></div></form><div className="settings-note"><Shield size={13} />No password leaves this device. There is no server account, sync, or password recovery.</div></section>
    </div><aside className="settings-side-column"><div className="deployment-card"><span className="deploy-badge"><i className="deploy-badge-dot" /> {runtime === 'live' ? 'LIVE RELAY' : 'VERCEL READY'}</span><h2>Zero-database<br />by design.</h2><p>Vercel hosts the app and a tiny signed-channel authorization route. Pusher forwards live events; it is not used as a database.</p><ul><li><Check size={13} /> Friends & settings stay local</li><li><Check size={13} /> Both players online for requests</li><li><Check size={13} /> No durable inbox or history</li><li><Check size={13} /> No offline push delivery</li></ul><span className="deploy-doc-link">{connected ? 'Connected to Pusher Channels' : 'See README for Pusher setup'}</span></div><div className="privacy-card"><Shield size={15} /><div><strong>Capability-code privacy</strong><p>Your friend code is a secret bearer invite. Share it only with people you trust; anyone who has it can address your live inbox.</p></div></div><div className="privacy-card"><Wifi size={15} /><div><strong>Connection status</strong><p>{connected ? 'Your browser is connected. Direct requests can be exchanged while your friends are online.' : 'The board works locally. Add Pusher credentials and enable client events to play online.'}</p></div></div></aside></div>
  </>;
}

function SettingToggle({ title, detail, checked, onChange }: { title: string; detail: string; checked: boolean; onChange: () => void }) {
  return <div className="setting-toggle-row"><span className="toggle-copy"><strong>{title}</strong><small>{detail}</small></span><button type="button" role="switch" aria-checked={checked} className={`toggle-switch${checked ? ' toggle-on' : ''}`} onClick={onChange}><span /></button></div>;
}

function GameRoom({ game, player, opponent, boardFen, mate, theme, coordinates, selectedSquare, legalTargets, premove, disabled, replayOpen, replayIndex, replayTotal, clocks, isMyTurn, gameColor, activeAction, incomingForMe, outgoingForMe, rematchIncoming, rematchWaiting, onBack, onSquareClick, onMoveDrop, onDragSelect, onCancelPremove, onPromotion, promotion, onCancelPromotion, onResign, resignConfirm, onToggleResign, onOfferDraw, onTakeback, onRespondAction, onRematch, onAnswerRematch, onReplay, onReplayIndex, onCloseReplay, onNewGame }: {
  game: GameRecord; player: PlayerProfile; opponent: PlayerProfile & { online?: boolean }; boardFen: string; mate: ReturnType<typeof mateInfo>;
  theme: BoardTheme; coordinates: boolean; selectedSquare: string | null; legalTargets: string[]; premove: Premove | null; disabled: boolean;
  replayOpen: boolean; replayIndex: number; replayTotal: number; clocks: { white: number; black: number }; isMyTurn: boolean; gameColor: 'w' | 'b';
  activeAction?: GameAction; incomingForMe: boolean; outgoingForMe: boolean; rematchIncoming: RematchRequest | null; rematchWaiting: boolean;
  onBack: () => void; onSquareClick: (square: string) => void; onMoveDrop: (from: string, to: string, promotion?: string) => void; onDragSelect: (square: string) => void;
  onCancelPremove: () => void; onPromotion: (piece: string) => void; promotion: { from: string; to: string } | null; onCancelPromotion: () => void;
  onResign: () => void; resignConfirm: boolean; onToggleResign: () => void; onOfferDraw: () => void; onTakeback: () => void;
  onRespondAction: (id: string, accepted: boolean) => void; onRematch: () => void; onAnswerRematch: (accepted: boolean) => void;
  onReplay: () => void; onReplayIndex: (index: number) => void; onCloseReplay: () => void; onNewGame: () => void;
}) {
  const moveRows: Array<{ number: number; white?: GameMove; black?: GameMove }> = [];
  const gameMoveList = allMoves(game);
  for (let index = 0; index < gameMoveList.length; index += 2) moveRows.push({ number: index / 2 + 1, white: gameMoveList[index], black: gameMoveList[index + 1] });
  const opponentClock = gameColor === 'w' ? clocks.black : clocks.white;
  const isFinished = !['active', 'pending'].includes(game.status);
  const checkSquare = (() => { try { const chess = new Chess(boardFen); if (!chess.isCheck()) return null; const color = chess.turn(); const board = chess.board(); for (let r = 0; r < 8; r += 1) for (let c = 0; c < 8; c += 1) if (board[r][c]?.type === 'k' && board[r][c]?.color === color) return `${'abcdefgh'[c]}${8 - r}`; return null; } catch { return null; } })();
  return <>
    <div className="game-header-row"><div className="game-title-block"><button className="back-link" onClick={onBack}><ArrowLeft size={12} /> Back to lobby</button><h1>{game.status === 'pending' ? 'Challenge sent' : game.localOnly ? 'Local practice' : `Game with ${opponent.display_name}`}</h1><div className="game-subtitle"><i className={`status-dot status-${game.status}`} />{game.status === 'active' ? (game.localOnly ? 'Two-player practice on this device' : 'Live game · moves sync through the relay') : statusLabel(game)}<span className="local-tag">{game.localOnly ? 'LOCAL' : 'LIVE'}</span></div></div><div className="game-header-actions">{game.status === 'active' && !game.localOnly && <span className="connection-pill"><i className="connection-dot" />Live relay</span>}<button className="icon-text-button" onClick={onBack}><ArrowLeft size={12} /> Lobby</button></div></div>
    {game.status === 'pending' ? <div className="pending-board-shell"><div className="pending-board-mark">♞</div><span className="eyebrow">DIRECT CHALLENGE</span><h2>Waiting for {opponent.display_name}.</h2><p>Your invitation is a live event. If they disconnect before accepting, you may need to send it again.</p><div className="pending-actions"><span className="connection-pill"><i className="connection-dot" />{timeControlLabel(game)} · {game.increment_seconds ? 'increment included' : 'no increment'}</span><button className="button button-outline" onClick={onBack}>Back to lobby</button></div><div className="pending-trust"><Shield size={13} />No durable inbox. Nothing is queued while they’re offline.</div></div> : <div className="game-workspace"><div className="board-column">
      <div className={`player-strip opponent-strip`}><span className="avatar board-player-avatar avatar-dark-side">{initials(opponent.display_name)}</span><span className="board-player-info"><strong>{opponent.display_name}</strong><small>{gameColor === 'w' ? 'Black pieces' : 'White pieces'}{!game.localOnly && opponent.online ? ' · online' : ''}</small></span><div className={`clock-box${(gameColor === 'w' ? clocks.black : clocks.white) < 30_000 ? ' clock-low' : game.turn_user_id === (gameColor === 'w' ? game.black_id : game.white_id) && game.status === 'active' ? ' clock-active' : ''}`}><i className="clock-turn-dot" />{formatClock(opponentClock)}</div></div>
      <div className={`board-theme-${theme}`}><ChessBoard fen={boardFen} rotate={gameColor === 'b'} selectedSquare={selectedSquare} legalTargets={legalTargets} lastMove={game.last_move} premove={premove} checkSquare={checkSquare} coordinates={coordinates} arrows={!replayOpen ? mate?.arrows || [] : []} disabled={disabled} onSquareClick={onSquareClick} onMoveDrop={onMoveDrop} onDragSelect={onDragSelect} /></div>
      <div className="turn-status">{replayOpen ? <><History size={12} /> Replay · {replayIndex} of {replayTotal} half-moves</> : game.status === 'active' ? <><i className={`turn-indicator${isMyTurn || game.localOnly ? ' turn-indicator-you' : ''}`} />{game.localOnly ? `${new Chess(game.fen).turn() === 'w' ? 'White' : 'Black'} to move · play both sides` : isMyTurn ? 'Your move' : `${opponent.display_name} to move`}<span className="safe-save-note"><Shield size={11} />{game.localOnly ? 'not saved' : 'session-only sync'}</span></> : isFinished ? <><Crown size={12} />{statusLabel(game)}<span className="safe-save-note"><Shield size={11} />No match history stored</span></> : null}</div>
      {promotion && <PromotionInline color={gameColor} onChoose={onPromotion} onCancel={onCancelPromotion} />}
      {premove && !replayOpen && <div className="premove-bar"><MoveUpRight size={13} /><span>Premove queued: <strong>{premove.from} → {premove.to}</strong></span><button onClick={onCancelPremove}><X size={12} /> Cancel</button></div>}
      {mate && !replayOpen && <div className="mate-explanation"><span className="mate-icon"><Crown size={15} /></span><div className="mate-copy"><span className="eyebrow">CHECKMATE EXPLAINED</span><strong>King trapped on {mate.king}</strong><p>{mate.attackers.length ? `Red arrows show ${mate.attackers.length} checking line${mate.attackers.length === 1 ? '' : 's'} into the king’s square.` : 'The king has no legal escape.'} Replay the moves or start a rematch.</p></div></div>}
      {replayOpen && <div className="replay-controls"><button className="button button-outline button-compact" disabled={replayIndex <= 0} onClick={() => onReplayIndex(Math.max(0, replayIndex - 1))}><ArrowLeft size={12} /> Previous</button><input type="range" min={0} max={replayTotal} value={Math.min(replayIndex, replayTotal)} onChange={(event) => onReplayIndex(Number(event.target.value))} aria-label="Replay move" /><button className="button button-outline button-compact" disabled={replayIndex >= replayTotal} onClick={() => onReplayIndex(Math.min(replayTotal, replayIndex + 1))}>Next <ArrowRight size={12} /></button><button className="icon-button" aria-label="Close replay" onClick={onCloseReplay}><X size={14} /></button></div>}
      {game.status !== 'active' && !replayOpen && <div className="game-over-card"><span className={`game-over-icon${game.status === 'draw' || game.status === 'stalemate' ? ' game-over-draw' : ''}`}><Trophy size={16} /></span><div className="game-over-copy"><span className="eyebrow">FINAL RESULT <i className="result-separator">·</i> {timeControlLabel(game)}</span><strong>{statusLabel(game)}</strong><p>{winnerSentence(game, player.id)}</p></div>{!game.localOnly && <button className="button button-soft play-again-button" onClick={onRematch}><RotateCcw size={12} /> Rematch</button>}{game.localOnly && <button className="button button-soft play-again-button" onClick={onNewGame}><RotateCcw size={12} /> New game</button>}<button className="button button-outline play-again-button" onClick={onReplay}><History size={12} /> Replay</button></div>}
      {activeAction && <div className="incoming-game-action"><span className="action-incoming-icon">{activeAction.type === 'draw' ? <Handshake size={13} /> : <RotateCcw size={13} />}</span><div><strong>{activeAction.requester_id === player.id ? `You offered a ${activeAction.type === 'draw' ? 'draw' : 'takeback'}` : `${opponent.display_name} requests a ${activeAction.type === 'draw' ? 'draw' : 'takeback'}`}</strong><small>{activeAction.requester_id === player.id ? 'Waiting for a response' : 'Choose whether to accept'}</small></div>{incomingForMe && <><button className="action-accept" onClick={() => onRespondAction(activeAction.id, true)}><Check size={11} /> Accept</button><button className="icon-button action-decline" aria-label="Decline offer" onClick={() => onRespondAction(activeAction.id, false)}><X size={12} /></button></>}{outgoingForMe && <span className="pending-label"><Clock3 size={11} /> Waiting</span>}</div>}
      {rematchIncoming && <div className="incoming-game-action"><span className="action-incoming-icon"><RotateCcw size={13} /></span><div><strong>{opponent.display_name} wants a rematch</strong><small>Colors will switch · {timeControlLabel(rematchIncoming.game)}</small></div><button className="action-accept" onClick={() => onAnswerRematch(true)}><Check size={11} /> Accept</button><button className="icon-button action-decline" aria-label="Decline rematch" onClick={() => onAnswerRematch(false)}><X size={12} /></button></div>}
      {rematchWaiting && <div className="outgoing-action-note"><Clock3 size={12} /> Waiting for your opponent to accept the rematch…</div>}
      <div className="board-help-note">Click or drag a piece. Legal squares are highlighted. While it is your opponent’s turn, select a move to queue a premove.</div>
    </div>
    <aside className="game-side-column"><section className="game-side-card game-summary-card"><div className="card-head"><div><span className="eyebrow">MATCH DETAILS</span><h3><span className="game-type-icon"><Swords size={14} /></span>{game.localOnly ? 'Local practice' : 'Friend match'}</h3></div><span className="head-count">{game.moves_count}</span></div><div className="game-detail-row"><span>Time control</span><strong><Timer size={12} /> {timeControlLabel(game)}</strong></div><div className="game-detail-row"><span>Status</span><strong className="status-value"><i className={`status-dot status-${game.status}`} />{statusLabel(game)}</strong></div><div className="game-detail-row"><span>Your color</span><strong>{gameColor === 'w' ? 'White' : 'Black'}</strong></div>
      {game.status === 'active' && <div className="game-controls"><button className="game-control-button" onClick={onOfferDraw} disabled={game.localOnly}><Handshake size={14} /><span>Offer draw</span><small>{game.localOnly ? 'Online only' : 'Ask to agree'}</small></button><button className="game-control-button" onClick={onTakeback} disabled={game.localOnly || game.moves_count === 0}><RotateCcw size={14} /><span>Takeback</span><small>{game.localOnly ? 'Online only' : 'Request undo'}</small></button><button className="game-control-button resign-control" onClick={onToggleResign}><Flag size={14} /><span>Resign</span><small>End this game</small></button></div>}
      {resignConfirm && game.status === 'active' && <div className="resign-confirm-row"><span>Resign this game?</span><button onClick={onToggleResign}>Keep playing</button><button className="resign-confirm-yes" onClick={onResign}>Resign</button></div>}
      {game.status === 'active' && <div className="challenge-time-note"><Clock3 size={13} /> Clock runs for <strong>{game.localOnly ? 'each side on this device' : 'the player to move'}</strong>.</div>}
      <div className="side-callout"><Shield size={12} /><span>{game.localOnly ? 'Local practice is not saved after this session.' : 'Match snapshots stay in this tab only; the relay carries live updates and does not archive games.'}</span></div>
    </section><section className="game-side-card move-history-card"><div className="card-head"><div><span className="eyebrow">NOTATION</span><h3>Move history</h3></div><span className="move-count-pill">{game.moves_count}</span></div><div className="move-history-list">{moveRows.length ? moveRows.map((row) => <div className="move-pair" key={row.number}><span className="move-number">{row.number}.</span><span className="white-san">{row.white?.san || ''}</span><span className="black-san">{row.black?.san || ''}</span></div>) : <div className="no-moves"><span className="opening-piece">♘</span><span>Game notation will appear here.<br /><small>White to move first</small></span></div>}</div></section><div className="network-health-card"><span className="network-health-icon"><Radio size={14} /></span><div><strong>{game.localOnly ? 'Local two-player mode' : 'Ephemeral realtime relay'}</strong><small>{game.localOnly ? 'Both colors can be moved on this device.' : 'If one player reconnects, the current tab can request a fresh snapshot.'}</small></div></div></aside></div>}
  </>;
}

function PromotionInline({ color, onChoose, onCancel }: { color: 'w' | 'b'; onChoose: (piece: string) => void; onCancel: () => void }) {
  return <div className="promotion-bar"><span>Promote to</span><div className="promotion-choices">{[['q','Queen'],['r','Rook'],['b','Bishop'],['n','Knight']].map(([piece,label]) => <button key={piece} onClick={() => onChoose(piece)}><span className="promotion-glyph">{color === 'w' ? ({ q:'♕',r:'♖',b:'♗',n:'♘' } as Record<string,string>)[piece] : ({ q:'♛',r:'♜',b:'♝',n:'♞' } as Record<string,string>)[piece]}</span><small>{label}</small></button>)}</div><button className="promotion-cancel" onClick={onCancel}>Cancel</button></div>;
}

function Toast({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  const isError = toast.tone === 'error';
  return <div className={`toast${isError ? ' toast-error' : toast.tone === 'success' ? ' toast-success' : ''}`} role="status"><span className="toast-icon">{isError ? <AlertTriangle size={14} /> : toast.tone === 'success' ? <Check size={14} /> : <Sparkles size={14} />}</span><span>{toast.text}</span><button aria-label="Dismiss" onClick={onClose}><X size={14} /></button></div>;
}
