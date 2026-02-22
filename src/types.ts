export interface Follower {
  pubkey: string;
  name?: string;
  picture?: string;
  baseHealth: number; // Used for health calculations (previously WoT score)
  position: { x: number; z: number };
  nip05?: string; // NIP-05 verification address
  lastPostTime?: number; // Unix timestamp of last post
  deleted?: boolean; // Account marked as deleted in kind 0 metadata
}

export type GameLevel = 'zombie' | 'neighborhood' | 'friends';

export interface LevelConfig {
  id: GameLevel;
  name: string;
  description: string;
  filterFn: (follower: Follower) => boolean;
}

export interface GameState {
  followers: Follower[];
  unfollowed: string[];
  playerPubkey: string;
}
