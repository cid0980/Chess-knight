export type PlayerProfile = {
  id: string;
  public_id: string;
  friend_code: string;
  username: string;
  display_name: string;
};

export type FriendRecord = PlayerProfile & { online?: boolean };

export type FriendRequest = {
  id: string;
  status: 'pending';
  direction: 'incoming' | 'outgoing';
  created_at: string;
  other_player: PlayerProfile;
};

export type GameStatus = 'pending' | 'active' | 'checkmate' | 'draw' | 'stalemate' | 'resigned' | 'timeout' | 'declined';
export type GameActionType = 'draw' | 'takeback' | 'rematch';

export type GameMove = {
  move_id?: string;
  user_id?: string;
  from_square: string;
  to_square: string;
  promotion?: string | null;
  san: string;
  fen_after?: string;
  pgn_after?: string;
  undone?: boolean;
  white_clock_ms?: number;
  black_clock_ms?: number;
  turn_user_id?: string | null;
  created_at?: string;
};

export type GameAction = {
  id: string;
  game_id: string;
  requester_id: string;
  recipient_id: string;
  type: GameActionType;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  game_version: number;
  created_at: string;
  other_player?: PlayerProfile;
};

export type GameRecord = {
  id: string;
  white_id: string;
  black_id: string;
  invited_by: string;
  invited_user_id: string;
  status: GameStatus;
  fen: string;
  pgn: string;
  turn_user_id: string | null;
  time_control_seconds: number;
  increment_seconds: number;
  white_clock_ms: number;
  black_clock_ms: number;
  started_at: string | null;
  turn_started_at: string | null;
  finished_at: string | null;
  winner_id: string | null;
  result_reason: string | null;
  moves_count: number;
  version: number;
  last_move: { from: string; to: string; san?: string } | null;
  created_at: string;
  updated_at: string;
  moves?: GameMove[];
  actions?: GameAction[];
  localOnly?: boolean;
};

export type ToastMessage = { id: number; text: string; tone?: 'success' | 'error' | 'info' };
