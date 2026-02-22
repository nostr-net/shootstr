import { GameRaycaster } from './game-raycaster';
import { NostrMetadata, NostrService, CachedFollowerRecord } from './nostr';
import { Follower, GameLevel, LevelConfig } from './types';

import { cache, CacheKeys } from './services/cache';

// NIP-07 window.nostr interface
declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: NostrUnsignedEvent): Promise<NostrSignedEvent>;
    };
  }
}

interface NostrUnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey: string;
}

interface NostrSignedEvent extends NostrUnsignedEvent {
  id: string;
  sig: string;
}

// Time thresholds in seconds
const ONE_MONTH = 30 * 24 * 60 * 60;
const SIX_MONTHS = 6 * ONE_MONTH;
const MAX_FOLLOWERS_PER_WAVE = 50;

class App {
  private nostr: NostrService;
  private game: GameRaycaster | null = null;
  private canvas: HTMLCanvasElement;
  private userPubkey: string | null = null;
  private useExtension: boolean = false;
  private allFollowers: Follower[] = [];
  private allFollowerPubkeys: string[] = [];
  private followerLookupByPubkey: Map<string, Follower> = new Map();
  private hasShownLevelSelection = false;

  private avatarTextureCache = new Map<string, HTMLCanvasElement>();
  private avatarLoadInFlight = new Set<string>();

  // Level configurations
  private levelConfigs: LevelConfig[] = [
    {
      id: 'zombie',
      name: 'Zombie Slaughter',
      description: 'Profiles that haven\'t posted in over 6 months',
      filterFn: (follower: Follower) => {
        const now = Math.floor(Date.now() / 1000);
        if (!this.hasKnownLastPostTime(follower.lastPostTime)) return false;
        return (now - follower.lastPostTime) > SIX_MONTHS;
      }
    },
    {
      id: 'neighborhood',
      name: 'Neighborhood Watch',
      description: 'Going stale - last posted 1 to 6 months ago',
      filterFn: (follower: Follower) => {
        if (!this.hasKnownLastPostTime(follower.lastPostTime)) return false;
        const age = Math.floor(Date.now() / 1000) - follower.lastPostTime;
        return age > ONE_MONTH && age <= SIX_MONTHS;
      }
    },
    {
      id: 'friends',
      name: 'Active Profiles',
      description: 'Most active profiles - posted within the last month',
      filterFn: (follower: Follower) => {
        if (!this.hasKnownLastPostTime(follower.lastPostTime)) return false;
        const age = Math.floor(Date.now() / 1000) - follower.lastPostTime;
        return age <= ONE_MONTH;
      }
    }
  ];

  private hasKnownLastPostTime(lastPostTime: unknown): lastPostTime is number {
    return typeof lastPostTime === 'number' && Number.isFinite(lastPostTime) && lastPostTime > 0;
  }

  constructor() {
    this.nostr = new NostrService();
    this.canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;

    this.setupUI();
  }

  private setupUI() {
    const startButton = document.getElementById('startButton') as HTMLButtonElement;
    const npubInput = document.getElementById('npubInput') as HTMLInputElement;
    const extensionButton = document.getElementById('extensionButton') as HTMLButtonElement;

    // Extension login button
    extensionButton.addEventListener('click', async () => {
      if (!window.nostr) {
        this.updateStatus('No Nostr extension found! Please install nos2x, Alby, or similar extension.');
        return;
      }

      try {
        extensionButton.disabled = true;
        this.updateStatus('Requesting public key from extension...');

        const pubkey = await window.nostr.getPublicKey();
        this.useExtension = true;
        this.userPubkey = pubkey;

        await this.loadAllFollowerData(pubkey);
      } catch (error) {
        console.error('Extension login error:', error);
        this.updateStatus(`Extension error: ${error}`);
        extensionButton.disabled = false;
      }
    });

    // Read-only login button
    startButton.addEventListener('click', async () => {
      const npubOrHex = npubInput.value.trim();

      if (!npubOrHex) {
        this.updateStatus('Please enter your npub or pubkey');
        return;
      }

      startButton.disabled = true;
      this.useExtension = false;
      await this.loadAllFollowerData(npubOrHex);
    });

    // Allow Enter key to start
    npubInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        startButton.click();
      }
    });

    // Level selection handlers
    this.setupLevelSelectionHandlers();
  }

  private setupLevelSelectionHandlers() {
    const levelCards = document.querySelectorAll('.level-card');
    levelCards.forEach(card => {
      card.addEventListener('click', () => {
        const level = card.getAttribute('data-level') as GameLevel;
        this.onLevelSelected(level);
      });
    });
  }

  /**
   * Load all follower data and show level selection screen
   */
  private async loadAllFollowerData(npubOrHex: string) {
    try {
      this.updateStatus('Decoding pubkey...');
      const pubkey = this.nostr.decodeNpub(npubOrHex);
      this.userPubkey = pubkey;
      console.log('Pubkey:', pubkey);
      console.log('Extension mode:', this.useExtension);

      this.updateStatus('Loading profiles...');
      this.hasShownLevelSelection = false;

      try {
        const { follows, followers } = await this.nostr.fetchGameDataWithCache(
          pubkey,
          (loaded, total) => {
            this.updateStatus(`Loading profiles... ${loaded}/${total}`);
          },
          false,
          (allFollows, followersBatch, loaded, total) => {
            this.applyFollowerDataUpdate(allFollows, followersBatch, loaded, total);
          }
        );

        if (!follows || follows.length === 0) {
          this.updateStatus('No followers found! Are you sure this is the right pubkey?');
          const startButton = document.getElementById('startButton') as HTMLButtonElement;
          startButton.disabled = false;
          return;
        }

        this.applyFollowerDataUpdate(follows, followers, follows.length, follows.length);

      } catch (error) {
        console.error('Nostr fetch error:', error);
        this.updateStatus(`Error fetching data: ${error}`);
        const startButton = document.getElementById('startButton') as HTMLButtonElement;
        startButton.disabled = false;
      }

    } catch (error) {
      console.error('Error loading follower data:', error);
      this.updateStatus(`Error: ${error}`);
      const startButton = document.getElementById('startButton') as HTMLButtonElement;
      startButton.disabled = false;
    }
  }

  /**
   * Display game data and show level selection
   */
  private applyFollowerDataUpdate(
    follows: string[],
    followers: CachedFollowerRecord[],
    loaded: number,
    total: number
  ) {
    this.allFollowerPubkeys = follows;
    const allFollowers = this.mapFollowerData(followers);
    this.allFollowers = allFollowers;
    this.followerLookupByPubkey = new Map(
      allFollowers.map((follower) => [follower.pubkey, follower]),
    );
    this.updateLevelCounts();

    const shouldShowLevelSelection =
      !this.hasShownLevelSelection &&
      (loaded >= total || this.hasFilledOneWave(allFollowers));

    if (shouldShowLevelSelection) {
      this.hasShownLevelSelection = true;
      this.updateStatus(`Loaded ${loaded}/${total} follower profiles`);
      // Start preloading all known avatar textures immediately once level selection is ready
      this.loadProfilePicturesInBackground(allFollowers)
        .catch(err => console.warn('Background profile picture load failed:', err));
      this.showLevelSelection();
      return;
    }

    if (this.hasShownLevelSelection) {
      // Keep texture loading rolling as new data arrives in the background.
      this.loadProfilePicturesInBackground(allFollowers)
        .catch(err => console.warn('Background profile picture load failed:', err));
    }
  }

  private hasFilledOneWave(followers: Follower[]): boolean {
    for (const config of this.levelConfigs) {
      let matching = 0;
      for (const follower of followers) {
        if (config.filterFn(follower)) {
          matching++;
          if (matching >= MAX_FOLLOWERS_PER_WAVE) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Compute a dormancy sort key for a follower.
   * Lower = more dormant = higher priority for early waves.
   * Order: burned (deleted) → no activity → oldest activity → newest activity.
   * Ties broken by pubkey for determinism.
   */
  private dormancySortKey(f: Follower): number {
    // Burned accounts get the lowest key (highest priority)
    if (f.deleted) return 0;
    // Unknown activity should stay out of waves instead of being sorted as never posted
    if (!this.hasKnownLastPostTime(f.lastPostTime)) return 1;
    // Otherwise, return 2 + lastPostTime so older posts sort first
    return 2 + f.lastPostTime;
  }

  /**
   * Get waves for a given level: filter, sort by dormancy, chunk into waves.
   * Wave 1 gets the most zombie-like accounts (burned, then ancient, etc).
   */
  private getWavesForLevel(level: GameLevel): Follower[][] {
    const levelConfig = this.levelConfigs.find(c => c.id === level)!;
    const levelFollowers = this.allFollowers.filter(levelConfig.filterFn);

    // Sort by dormancy (most dormant first), break ties by pubkey
    const sorted = [...levelFollowers].sort((a, b) => {
      const ka = this.dormancySortKey(a);
      const kb = this.dormancySortKey(b);
      if (ka !== kb) return ka - kb;
      return a.pubkey.localeCompare(b.pubkey);
    });

    // Chunk into waves
    const waves: Follower[][] = [];
    for (let i = 0; i < sorted.length; i += MAX_FOLLOWERS_PER_WAVE) {
      waves.push(sorted.slice(i, i + MAX_FOLLOWERS_PER_WAVE));
    }
    return waves;
  }

  /**
   * Update level counts with wave info
   */
  private updateLevelCounts() {
    if (!this.allFollowers || this.allFollowers.length === 0) {
      return;
    }

    this.levelConfigs.forEach((config) => {
      const waves = this.getWavesForLevel(config.id);
      const totalTargets = waves.reduce((sum, w) => sum + w.length, 0);
      const countElement = document.getElementById(
        `${config.id}Count`
      ) as HTMLElement;
      if (countElement) {
        if (waves.length > 1) {
          countElement.textContent = `${totalTargets} targets (${waves.length} waves)`;
        } else {
          countElement.textContent = `${totalTargets} targets`;
        }
      }
    });
  }

  private resolveFollowerName(
    pubkey: string,
    metadata: NostrMetadata | undefined,
    directName: string | undefined,
    index: number
  ): string {
    const trimmedDirect = directName?.trim();
    const usableDirect = trimmedDirect && !/^anon/i.test(trimmedDirect) ? trimmedDirect : undefined;

    return usableDirect
      || metadata?.name
      || metadata?.display_name
      || metadata?.nip05
      || (pubkey ? `${pubkey.slice(0, 8)}...` : `Anon${index}`);
  }

  private mapFollowerData(followers: CachedFollowerRecord[]): Follower[] {
    return followers.map((followerData, index) => {
      const metadata = followerData?.metadata;
      const pubkey = followerData?.pubkey || '';
      const directName = metadata?.name || metadata?.display_name;
      const lastPostTime = this.hasKnownLastPostTime(followerData?.lastPostTime)
        ? followerData.lastPostTime
        : undefined;

      return {
        pubkey,
        name: this.resolveFollowerName(pubkey, metadata, directName, index),
        picture: metadata?.picture,
        baseHealth: typeof followerData?.baseHealth === 'number' ? followerData.baseHealth : 1,
        nip05: metadata?.nip05,
        lastPostTime,
        deleted: !!followerData?.deleted,
        position: { x: 0, z: 0 }
      };
    });
  }

  /**
   * Show level selection screen with counts
   */
  private showLevelSelection() {
    this.updateLevelCounts();

    document.getElementById('levelStatus')!.textContent = 'Select a level to begin hunting';

    // Hide login screen, show level selection
    this.hideLoadingScreen();
    this.showScreen('levelSelectScreen');
  }

  /**
   * Handle level selection — auto-start at saved wave progress
   */
  private async onLevelSelected(level: GameLevel) {
    console.log('Level selected:', level);

    const waves = this.getWavesForLevel(level);

    if (waves.length === 0) {
      document.getElementById('levelStatus')!.textContent = 'No targets found for this level!';
      return;
    }

    // Resume from saved progress (or start at 0)
    const savedWave = await this.loadWaveProgress(level);
    const startWave = savedWave < waves.length ? savedWave : 0;

    this.hideScreen('levelSelectScreen');
    this.showScreen('loadingDataScreen');
    await this.loadGameWithWave(level, startWave);
  }

  private async loadWaveProgress(level: GameLevel): Promise<number> {
    if (!this.userPubkey) return 0;
    const progress = await cache.get<{ lastWave: number }>(
      CacheKeys.waveProgress(this.userPubkey, level)
    );
    return progress?.lastWave ?? 0;
  }

  private async saveWaveProgress(level: GameLevel, waveIndex: number): Promise<void> {
    if (!this.userPubkey) return;
    await cache.set(
      CacheKeys.waveProgress(this.userPubkey, level),
      { lastWave: waveIndex },
      86400000 // 24hr
    );
  }

  /**
   * Load game with a specific wave of a level
   */
  private async loadGameWithWave(level: GameLevel, waveIndex: number) {
    try {
      const levelConfig = this.levelConfigs.find(c => c.id === level)!;
      const waves = this.getWavesForLevel(level);
      const waveFollowers = waves[waveIndex];

      if (!waveFollowers || waveFollowers.length === 0) {
        this.updateLoadingStatus('No targets found for this wave!');
        await this.sleep(2000);
        this.hideScreen('loadingDataScreen');
        this.showScreen('levelSelectScreen');
        return;
      }

      const waveLabel = waves.length > 1 ? ` (Wave ${waveIndex + 1}/${waves.length})` : '';
      this.updateLoadingStatus(`Loading ${levelConfig.name}${waveLabel}...`);
      await this.sleep(500);

      this.updateLoadingStatus(`Found ${waveFollowers.length} targets...`);
      await this.sleep(300);

      // Initialize game
      this.game = new GameRaycaster(this.canvas);

      // Spawn followers
      this.game.spawnFollowers(waveFollowers, new Map(this.avatarTextureCache));

      // Update HUD wave info
      const waveInfoEl = document.getElementById('waveInfo');
      if (waveInfoEl) {
        if (waves.length > 1) {
          waveInfoEl.textContent = `Wave ${waveIndex + 1}/${waves.length}`;
          waveInfoEl.style.display = '';
        } else {
          waveInfoEl.style.display = 'none';
        }
      }

      // When the game ends (exit door), auto-advance to next wave or return to level select
      this.game.setRestartCallback(() => {
        this.game = null;

        const nextWave = waveIndex + 1;
        if (nextWave < waves.length) {
          // Auto-advance to next wave
          this.saveWaveProgress(level, nextWave).catch(() => {});
          this.showScreen('loadingDataScreen');
          this.loadGameWithWave(level, nextWave);
        } else {
          // All waves complete, reset progress and return to level select
          this.saveWaveProgress(level, 0).catch(() => {});
          this.showLevelSelection();
        }
      });

      // Set up batch unfollow callback
      if (this.userPubkey) {
        this.game.setUnfollowCallback(async (unfollowedPubkeys: string[]) => {
          if (this.useExtension) {
            await this.nostr.batchUnfollowPubkeys(
              this.userPubkey!,
              unfollowedPubkeys,
              this.allFollowerPubkeys,
              true
            );
            return { status: 'published' };
          }

          return {
            status: 'prepared',
            signWithExtension: async () => {
              await this.nostr.batchUnfollowPubkeys(
                this.userPubkey!,
                unfollowedPubkeys,
                this.allFollowerPubkeys,
                true
              );
            }
          };
        });
      }

      this.updateLoadingStatus('Starting game...');
      this.game.start();
      await this.sleep(500);

      // Hide loading screen
      this.hideScreen('loadingDataScreen');

      // Load profile pictures in background
      this.loadProfilePicturesInBackground(waveFollowers)
        .catch(err => console.warn('Background profile picture load failed:', err));

    } catch (error) {
      console.error('Error loading game:', error);
      this.updateLoadingStatus(`Error: ${error}`);
      await this.sleep(2000);
      this.hideScreen('loadingDataScreen');
      this.showScreen('levelSelectScreen');
    }
  }

  /**
   * Load profile pictures in the background without blocking
   */
  private async loadProfilePicturesInBackground(followers: Follower[]) {
    const pubkeys = followers
      .map((follower) => follower.pubkey)
      .filter((pubkey) => !!pubkey);
    const uniquePubkeys = Array.from(new Set(pubkeys));
    const toLoad = uniquePubkeys.filter(
      (pubkey) => !this.avatarTextureCache.has(pubkey) && !this.avatarLoadInFlight.has(pubkey)
    );

    if (toLoad.length === 0) {
      return;
    }

    console.log(`Loading ${toLoad.length} profile pictures in background`);
    const batchSize = 6;

    for (let i = 0; i < toLoad.length; i += batchSize) {
      const batch = toLoad.slice(i, i + batchSize);
      await Promise.all(
        batch.map((pubkey) => this.loadAvatarTexture(pubkey))
      );
      // Throttle slightly to avoid overwhelming the browser.
      await this.sleep(25);
    }

    console.log('Background profile pictures loaded');
  }

  private async loadAvatarTexture(pubkey: string): Promise<void> {
    if (this.avatarTextureCache.has(pubkey) || this.avatarLoadInFlight.has(pubkey)) {
      return;
    }

    this.avatarLoadInFlight.add(pubkey);

    try {
      const follower = this.followerLookupByPubkey.get(pubkey);
      const avatarUrl = follower?.picture;

      if (!avatarUrl) {
        throw new Error('No picture URL');
      }

      const img = await this.nostr.loadProfilePicture(avatarUrl);
      const circularAvatar = this.nostr.createCircularAvatar(img, 128);
      this.avatarTextureCache.set(pubkey, circularAvatar);

      // Always update the running game if one exists
      if (this.game) {
        this.game.updateSpriteTexture(pubkey, circularAvatar);
      }
    } catch (error) {
      // Fail silently/gracefully - game will use default color
    } finally {
      this.avatarLoadInFlight.delete(pubkey);
    }
  }

  private showScreen(screenId: string) {
    const screen = document.getElementById(screenId);
    if (screen) {
      screen.classList.add('active');
    }
  }

  private hideScreen(screenId: string) {
    const screen = document.getElementById(screenId);
    if (screen) {
      screen.classList.remove('active');
    }
  }

  private updateLoadingStatus(message: string) {
    const statusEl = document.getElementById('loadingDataStatus');
    if (statusEl) {
      statusEl.textContent = message;
    }
    console.log(message);
  }

  private updateStatus(message: string) {
    const statusEl = document.getElementById('statusText');
    if (statusEl) {
      statusEl.textContent = message;
    }
    console.log(message);
  }

  private hideLoadingScreen() {
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
      loadingScreen.classList.add('hidden');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new App();
  });
} else {
  new App();
}
