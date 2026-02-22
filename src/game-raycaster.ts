import { Raycaster, Sprite } from './raycaster';
import { Follower } from './types';
import { Minimap } from './minimap';

/**
 * Escape HTML special characters to prevent XSS attacks
 * Used when inserting user-controlled content (like follower names) into the DOM
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

type BatchUnfollowResult =
  | { status: 'published' }
  | { status: 'prepared'; signWithExtension: () => Promise<void> };

export class GameRaycaster {
  private raycaster: Raycaster;
  private canvas: HTMLCanvasElement;
  private animationId: number | null = null;
  private lastTime: number = 0;
  private lastMinimapRenderTime: number = 0;
  private readonly MINIMAP_RENDER_INTERVAL_MS = 83;

  private keys: Set<string> = new Set();
  private mouseMovementX: number = 0;
  private isPointerLocked: boolean = false;

  private unfollowedCount: number = 0;

  // Shooting
  private lastShotTime: number = 0;
  private shotCooldown: number = 200; // ms

  // Minimap
  private minimap: Minimap;

  // Kill state tracking (instead of immediate signing)
  private markedFollowers: Array<{pubkey: string, name: string}> = [];
  private spritesByPubkey: Map<string, Sprite> = new Map();
  private aliveSpriteCount: number = 0;

  // Unfollow callback for NIP-07 signing (used for batch signing at end)
  private unfollowCallback: ((pubkeys: string[]) => Promise<BatchUnfollowResult>) | null = null;

  // Called when the game should end and return to level selection
  private restartCallback: (() => void) | null = null;

  // Stored event handler references for cleanup
  private handleKeyDown: (e: KeyboardEvent) => void;
  private handleKeyUp: (e: KeyboardEvent) => void;
  private handleMouseMove: (e: MouseEvent) => void;
  private handleCanvasClick: (e: MouseEvent) => void;
  private handlePointerLockChange: () => void;
  private handleResize: () => void;

  // Cached HUD DOM elements
  private followerCountEl: HTMLElement | null;
  private unfollowCountEl: HTMLElement | null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    // Cache HUD DOM elements
    this.followerCountEl = document.getElementById('followerCount');
    this.unfollowCountEl = document.getElementById('unfollowCount');

    // Set canvas size to window size
    this.resizeCanvas();
    this.handleResize = () => this.resizeCanvas();
    window.addEventListener('resize', this.handleResize);

    this.raycaster = new Raycaster(canvas);

    // Initialize minimap
    this.minimap = new Minimap('minimap');

    // Create bound handlers for proper cleanup
    this.handleKeyDown = (e: KeyboardEvent) => {
      if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
        e.preventDefault();
      }
      this.keys.add(e.key.toLowerCase());
      if (e.key === ' ' && this.isPointerLocked) {
        this.shoot();
      }
      if (e.key === 'Escape') {
        document.exitPointerLock();
      }
    };

    this.handleKeyUp = (e: KeyboardEvent) => {
      if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
      }
      this.keys.delete(e.key.toLowerCase());
    };

    this.handleMouseMove = (e: MouseEvent) => {
      if (this.isPointerLocked) {
        this.mouseMovementX += e.movementX;
      }
    };

    // Single click handler: pointer lock OR shoot (fixes race condition)
    this.handleCanvasClick = () => {
      if (this.isPointerLocked) {
        this.shoot();
      } else {
        this.canvas.requestPointerLock();
      }
    };

    this.handlePointerLockChange = () => {
      this.isPointerLocked = document.pointerLockElement === this.canvas;
      if (!this.isPointerLocked) {
        console.log('Pointer unlocked - click to resume');
      }
    };

    this.setupControls();

    // Set up exit door callback
    this.raycaster.setExitDoorCallback(() => {
      this.showCleanupScreen();
    });
  }

  private resizeCanvas(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    if (this.raycaster) {
      this.raycaster.setViewportSize(this.canvas.width, this.canvas.height);
    }
  }

  private setupControls(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    this.canvas.addEventListener('mousemove', this.handleMouseMove);
    this.canvas.addEventListener('click', this.handleCanvasClick);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  public start(): void {
    if (this.animationId === null) {
      this.lastTime = performance.now();
      this.gameLoop(this.lastTime);
    }
  }

  public stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  private gameLoop(currentTime: number): void {
    const deltaTime = currentTime - this.lastTime;
    this.lastTime = currentTime;

    // Update game state
    this.update(deltaTime);

    // Render
    this.raycaster.render(deltaTime);

    // Render minimap less frequently than the main frame loop.
    if (currentTime - this.lastMinimapRenderTime >= this.MINIMAP_RENDER_INTERVAL_MS) {
      this.minimap.render(this.raycaster.map, this.raycaster.player, this.raycaster.sprites);
      this.lastMinimapRenderTime = currentTime;
    }

    // Continue loop
    this.animationId = requestAnimationFrame((time) => this.gameLoop(time));
  }

  private update(deltaTime: number): void {
    // Update player movement
    this.updatePlayerMovement(deltaTime);

    // Check if player is in exit door zone
    this.raycaster.checkExitDoorZone();

    // Update sprites
    this.raycaster.updateSprites(deltaTime);
  }

  private updatePlayerMovement(_deltaTime: number): void {
    let forward = 0;
    let rotation = 0;

    // Forward/backward movement with W/S and arrow keys
    if (this.keys.has('w') || this.keys.has('arrowup')) forward += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) forward -= 1;

    // Rotation with A/D and arrow keys
    if (this.keys.has('a') || this.keys.has('arrowleft')) rotation -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) rotation += 1;

    // Apply movement (no strafing, just forward/backward)
    if (forward !== 0) {
      this.raycaster.movePlayer(forward, 0);
    }

    // Apply rotation
    if (rotation !== 0) {
      this.raycaster.rotatePlayer(rotation);
    }

    // Mouse rotation
    if (this.mouseMovementX !== 0) {
      const sensitivity = 0.002;
      this.raycaster.rotatePlayer(this.mouseMovementX * sensitivity * 10);
      this.mouseMovementX = 0;
    }
  }

  private shoot(): void {
    const now = Date.now();
    if (now - this.lastShotTime < this.shotCooldown) {
      return; // Cooldown
    }

    this.lastShotTime = now;

    // Trigger weapon animation
    this.raycaster.triggerShot();

    // Cast ray and check for hit
    const hitSprite = this.raycaster.shootRay();

    if (hitSprite) {
      this.hitFollower(hitSprite);
      this.raycaster.addHitMarker(hitSprite);
    }

    // Visual feedback
    this.flashScreen();
  }

  private hitFollower(sprite: Sprite): void {
    const damage = 20;
    sprite.health -= damage;

    console.log(`Hit ${sprite.name} (${sprite.pubkey.slice(0, 8)}...) - Health: ${sprite.health}`);

    if (sprite.health <= 0) {
      sprite.health = 0;
      sprite.state = 'dying';
      this.unfollowFollower(sprite);
    }
  }

  private unfollowFollower(sprite: Sprite): void {
    console.log(`🎯 KILLED: ${sprite.name} (${sprite.pubkey.slice(0, 8)}...)`);

    if (sprite.state === 'idle' || sprite.state === 'walking') {
      this.aliveSpriteCount = Math.max(0, this.aliveSpriteCount - 1);
    }

    // Track marked follower instead of immediately signing
    this.markedFollowers.push({
      pubkey: sprite.pubkey,
      name: sprite.name
    });

    // Animation will be handled by sprite update
    setTimeout(() => {
      this.removeSprite(sprite.pubkey);
      this.unfollowedCount++;
      this.updateHUD();
    }, 500);

    this.updateHUD();
  }

  public setUnfollowCallback(callback: (pubkeys: string[]) => Promise<BatchUnfollowResult>): void {
    this.unfollowCallback = callback;
  }

  public setRestartCallback(callback: () => void): void {
    this.restartCallback = callback;
  }

  /**
   * Get the list of marked followers (for showing in cleanup screen)
   */
  public getMarkedFollowers(): Array<{pubkey: string, name: string}> {
    return [...this.markedFollowers];
  }

  /**
   * Batch unfollow all marked followers
   */
  public async batchUnfollowMarkedFollowers(): Promise<BatchUnfollowResult | null> {
    if (this.markedFollowers.length === 0) {
      console.log('No followers to unfollow');
      return null;
    }

    console.log(`Batch unfollowing ${this.markedFollowers.length} followers`);

    if (this.unfollowCallback) {
      const pubkeys = this.markedFollowers.map(f => f.pubkey);
      return await this.unfollowCallback(pubkeys);
    }
    return null;
  }

  /**
   * Clear marked followers list (when user cancels)
   */
  public clearMarkedFollowers(): void {
    console.log('Clearing marked followers list (user cancelled)');
    this.markedFollowers = [];
  }

  /**
   * Update the texture of a sprite (for lazy-loading profile pictures)
   */
  public updateSpriteTexture(pubkey: string, texture: HTMLCanvasElement): void {
    const sprite = this.spritesByPubkey.get(pubkey);
    if (sprite) {
      sprite.texture = texture;
      console.log(`Updated texture for ${sprite.name}`);
    }
  }

  /**
   * Dynamically add followers to the game while it's running
   * Used for lazy loading followers in the background
   */
  public addFollowersDynamically(followers: Follower[]): void {
    console.log(`Dynamically adding ${followers.length} followers to game`);

    // Find available spawn positions
    const spacesByDistance: Array<{x: number, y: number, dist: number}> = [];

    for (let y = 1; y < this.raycaster.map.height - 1; y++) {
      for (let x = 1; x < this.raycaster.map.width - 1; x++) {
        if (this.raycaster.map.grid[y][x] === 0) {
          // Check if position is already occupied by a sprite
          const occupied = this.raycaster.sprites.some(s => {
            const dx = Math.abs(s.x - (x + 0.5));
            const dy = Math.abs(s.y - (y + 0.5));
            return dx < 0.5 && dy < 0.5;
          });

          if (!occupied) {
            const dx = x + 0.5 - this.raycaster.player.x;
            const dy = y + 0.5 - this.raycaster.player.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > 2) {
              spacesByDistance.push({ x: x + 0.5, y: y + 0.5, dist });
            }
          }
        }
      }
    }

    // Sort by distance
    spacesByDistance.sort((a, b) => a.dist - b.dist);

    // Sort followers by baseHealth (lowest to highest)
    const sortedFollowers = [...followers].sort((a, b) => a.baseHealth - b.baseHealth);

    sortedFollowers.forEach((follower, index) => {
      if (index >= spacesByDistance.length) {
        console.warn('No more spawn positions available');
        return;
      }

      if (this.spritesByPubkey.has(follower.pubkey)) {
        return;
      }

      const pos = spacesByDistance[index];

      const sprite: Sprite = {
        x: pos.x,
        y: pos.y,
        texture: GameRaycaster.createFallbackTexture(follower.name || 'Anon'), // Will be updated when profile picture loads
        pubkey: follower.pubkey,
        name: follower.name || 'Anon',
        health: follower.baseHealth,
        maxHealth: follower.baseHealth,
        lastPostTime: follower.lastPostTime,
        vx: 0,
        vy: 0,
        state: 'idle',
        animationFrame: 0,
        nextMoveTime: Date.now() + Math.random() * 2000
      };

      this.raycaster.addSprite(sprite);
      this.spritesByPubkey.set(sprite.pubkey, sprite);
      this.aliveSpriteCount++;
    });

    this.updateHUD();
    console.log(`Added ${sortedFollowers.length} followers dynamically`);
  }

  private flashScreen(): void {
    // Quick muzzle flash effect
    const canvas = this.canvas;
    const ctx = canvas.getContext('2d')!;

    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 200, 0.2)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  public spawnFollowers(followers: Follower[], textures: Map<string, HTMLCanvasElement>): void {
    console.log(`Spawning ${followers.length} followers as sprites (${textures.size} textures loaded)`);

    // Find open spaces in the map categorized by distance from player
    const spacesByDistance: Array<{x: number, y: number, dist: number}> = [];

    for (let y = 1; y < this.raycaster.map.height - 1; y++) {
      for (let x = 1; x < this.raycaster.map.width - 1; x++) {
        if (this.raycaster.map.grid[y][x] === 0) {
          // Calculate distance from player
          const dx = x + 0.5 - this.raycaster.player.x;
          const dy = y + 0.5 - this.raycaster.player.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist > 2) {
            spacesByDistance.push({ x: x + 0.5, y: y + 0.5, dist });
          }
        }
      }
    }

    // Sort spaces by distance (closest to furthest)
    spacesByDistance.sort((a, b) => a.dist - b.dist);

    // Sort followers by baseHealth (lowest to highest)
    // Lower health spawns closer, higher health spawns further
    const sortedFollowers = [...followers].sort((a, b) => a.baseHealth - b.baseHealth);
    const availableSpaces = [...spacesByDistance];

    for (let index = 0; index < sortedFollowers.length; index++) {
      const follower = sortedFollowers[index];
      if (availableSpaces.length === 0) {
        console.warn('No more spawn positions available');
        break;
      }

      if (this.spritesByPubkey.has(follower.pubkey)) {
        continue;
      }

      // Texture will be loaded later if not available
      const texture = textures.get(follower.pubkey) || GameRaycaster.createFallbackTexture(follower.name || 'Anon');

      // Map follower index to spawn position
      // Distribute evenly across available spaces
      const spaceIndex = Math.floor((index / sortedFollowers.length) * availableSpaces.length);

      // Add some randomization within the same distance tier
      const tierSize = Math.ceil(availableSpaces.length / sortedFollowers.length);
      const tierStart = Math.max(0, spaceIndex - tierSize);
      const tierEnd = Math.min(availableSpaces.length, spaceIndex + tierSize + 1);
      const randomIndex = tierStart + Math.floor(Math.random() * (tierEnd - tierStart));
      const selectedIndex = Math.min(randomIndex, availableSpaces.length - 1);
      const selectedPos = availableSpaces[selectedIndex];
      const lastIndex = availableSpaces.length - 1;
      availableSpaces[selectedIndex] = availableSpaces[lastIndex];
      availableSpaces.pop();

      const sprite: Sprite = {
        x: selectedPos.x,
        y: selectedPos.y,
        texture: texture,
        pubkey: follower.pubkey,
        name: follower.name || 'Anon',
        health: follower.baseHealth,
        maxHealth: follower.baseHealth,
        lastPostTime: follower.lastPostTime,
        vx: 0,
        vy: 0,
        state: 'idle',
        animationFrame: 0,
        nextMoveTime: Date.now() + Math.random() * 2000
      };

      this.raycaster.addSprite(sprite);
      this.spritesByPubkey.set(sprite.pubkey, sprite);
      this.aliveSpriteCount++;

      if (!textures.has(follower.pubkey)) {
        console.log(`Spawned ${follower.name} (health: ${follower.baseHealth}) - texture will load in background`);
      }
    }

    this.updateHUD();
    console.log(`Spawned ${followers.length} followers (textures loading in background)`);
  }

  private updateHUD(): void {
    if (this.followerCountEl) {
      this.followerCountEl.textContent = this.aliveSpriteCount.toString();
    }

    if (this.unfollowCountEl) {
      this.unfollowCountEl.textContent = this.unfollowedCount.toString();
    }
  }

  /**
   * Show cleanup screen with list of marked followers
   */
  private showCleanupScreen(): void {
    console.log('Player entered exit door - showing cleanup screen');

    // Pause the game
    this.stop();

    // Unlock pointer
    document.exitPointerLock();

    const cleanupScreen = document.getElementById('cleanupScreen');
    const cleanupContent = document.getElementById('cleanupContent');

    if (!cleanupScreen || !cleanupContent) {
      console.error('Cleanup screen elements not found');
      return;
    }

    const markedFollowers = this.getMarkedFollowers();

    if (markedFollowers.length === 0) {
      // No kills, just show a message and back button
      cleanupContent.innerHTML = `
        <div class="no-kills-message">No followers were killed. You're a pacifist! 🕊️</div>
        <button class="cleanup-back-button" id="backToGameButton">BACK TO GAME</button>
      `;

      const backButton = document.getElementById('backToGameButton');
      if (backButton) {
        backButton.addEventListener('click', () => {
          this.hideCleanupScreen();
        });
      }
    } else {
      // Show marked followers list and confirmation targets
      // Escape follower names to prevent XSS from malicious Nostr profile data
      const followerListHTML = markedFollowers
        .map(f => `<div class="cleanup-list-item">• ${escapeHtml(f.name)}</div>`)
        .join('');

      cleanupContent.innerHTML = `
        <div class="cleanup-list">
          <strong>Followers to unfollow (${markedFollowers.length}):</strong>
          ${followerListHTML}
        </div>
        <div class="cleanup-instructions">SHOOT YOUR CHOICE:</div>
        <div class="cleanup-targets">
          <div class="target confirm" id="confirmTarget">FUCK<br>YEAH</div>
          <div class="target cancel" id="cancelTarget">LOSERS<br>UNITE</div>
        </div>
      `;

      // Add click handlers for targets
      const confirmTarget = document.getElementById('confirmTarget');
      const cancelTarget = document.getElementById('cancelTarget');

      if (confirmTarget) {
        confirmTarget.addEventListener('click', () => {
          this.handleCleanupConfirm();
        });
      }

      if (cancelTarget) {
        cancelTarget.addEventListener('click', () => {
          this.handleCleanupCancel();
        });
      }
    }

    cleanupScreen.classList.add('active');
  }

  /**
   * Hide cleanup screen and resume game
   */
  private hideCleanupScreen(): void {
    const cleanupScreen = document.getElementById('cleanupScreen');
    if (cleanupScreen) {
      cleanupScreen.classList.remove('active');
    }

    // End this game and return to level selection
    this.dispose();
    if (this.restartCallback) {
      this.restartCallback();
    }
  }

  /**
   * Handle cleanup confirmation (batch unfollow)
   */
  private async handleCleanupConfirm(): Promise<void> {
    console.log('User confirmed - batch unfollowing marked followers');

    const cleanupContent = document.getElementById('cleanupContent');
    if (cleanupContent) {
      cleanupContent.innerHTML = `
        <div class="cleanup-instructions">Preparing unfollow event...</div>
      `;
    }

    try {
      const result = await this.batchUnfollowMarkedFollowers();

      if (!cleanupContent) {
        return;
      }

      if (!result) {
        cleanupContent.innerHTML = `
          <div class="cleanup-instructions" style="color: #ff0;">Unfollow event prepared. Connect an extension to sign.</div>
          <button class="cleanup-back-button" id="backToGameButton">BACK TO GAME</button>
        `;
        const backButton = document.getElementById('backToGameButton');
        if (backButton) {
          backButton.addEventListener('click', () => {
            this.hideCleanupScreen();
          });
        }
        return;
      }

      if (result.status === 'published') {
        this.clearMarkedFollowers();
        cleanupContent.innerHTML = `
          <div class="cleanup-instructions" style="color: #0f0;">✓ Successfully unfollowed all killed followers!</div>
          <button class="cleanup-back-button" id="backToGameButton">BACK TO GAME</button>
        `;

        const backButton = document.getElementById('backToGameButton');
        if (backButton) {
          backButton.addEventListener('click', () => {
            this.hideCleanupScreen();
          });
        }
        return;
      }

      cleanupContent.innerHTML = `
        <div class="cleanup-instructions" style="color: #ff0;">Unfollow event prepared. Sign with extension to publish.</div>
        <button class="cleanup-back-button" id="signUnfollowButton">SIGN WITH EXTENSION</button>
        <button class="cleanup-back-button" id="backToGameButton">BACK TO GAME</button>
      `;

      const signButton = document.getElementById('signUnfollowButton');
      if (signButton) {
        signButton.addEventListener('click', async () => {
          cleanupContent.innerHTML = `
            <div class="cleanup-instructions">Signing unfollow event...</div>
          `;

          try {
            await result.signWithExtension();
            this.clearMarkedFollowers();
            cleanupContent.innerHTML = `
              <div class="cleanup-instructions" style="color: #0f0;">✓ Successfully unfollowed all killed followers!</div>
              <button class="cleanup-back-button" id="backToGameButton">BACK TO GAME</button>
            `;

            const backButton = document.getElementById('backToGameButton');
            if (backButton) {
              backButton.addEventListener('click', () => {
                this.hideCleanupScreen();
              });
            }
          } catch (error) {
            console.error('Failed to batch unfollow:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            cleanupContent.innerHTML = `
              <div class="cleanup-instructions" style="color: #f00;">✗ Failed to unfollow: ${escapeHtml(errorMessage)}</div>
              <button class="cleanup-back-button" id="backToGameButton">BACK TO GAME</button>
            `;

            const backButton = document.getElementById('backToGameButton');
            if (backButton) {
              backButton.addEventListener('click', () => {
                this.hideCleanupScreen();
              });
            }
          }
        });
      }

      const backButton = document.getElementById('backToGameButton');
      if (backButton) {
        backButton.addEventListener('click', () => {
          this.hideCleanupScreen();
        });
      }
    } catch (error) {
      console.error('Failed to batch unfollow:', error);

      if (cleanupContent) {
        // Escape error message to prevent XSS
        const errorMessage = error instanceof Error ? error.message : String(error);
        cleanupContent.innerHTML = `
          <div class="cleanup-instructions" style="color: #f00;">✗ Failed to unfollow: ${escapeHtml(errorMessage)}</div>
          <button class="cleanup-back-button" id="backToGameButton">BACK TO GAME</button>
        `;

        const backButton = document.getElementById('backToGameButton');
        if (backButton) {
          backButton.addEventListener('click', () => {
            this.hideCleanupScreen();
          });
        }
      }
    }
  }

  /**
   * Handle cleanup cancellation (clear marked followers list)
   */
  private handleCleanupCancel(): void {
    console.log('User cancelled - clearing marked followers list');

    this.clearMarkedFollowers();

    const cleanupContent = document.getElementById('cleanupContent');
    if (cleanupContent) {
      cleanupContent.innerHTML = `
        <div class="cleanup-instructions" style="color: #ff0;">Cancelled - marked followers list cleared</div>
        <button class="cleanup-back-button" id="backToGameButton">BACK TO GAME</button>
      `;

      const backButton = document.getElementById('backToGameButton');
      if (backButton) {
        backButton.addEventListener('click', () => {
          this.hideCleanupScreen();
        });
      }
    }
  }

  private static createFallbackTexture(name: string): HTMLCanvasElement {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Deterministic color from name
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;

    ctx.fillStyle = `hsl(${hue}, 60%, 40%)`;
    ctx.fillRect(0, 0, size, size);

    // Draw initial
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 32px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name.charAt(0).toUpperCase(), size / 2, size / 2);

    return canvas;
  }

  public dispose(): void {
    this.stop();
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('resize', this.handleResize);
    this.canvas.removeEventListener('mousemove', this.handleMouseMove);
    this.canvas.removeEventListener('click', this.handleCanvasClick);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
  }

  private removeSprite(pubkey: string): void {
    const index = this.raycaster.sprites.findIndex(s => s.pubkey === pubkey);
    if (index !== -1) {
      this.raycaster.sprites.splice(index, 1);
      this.spritesByPubkey.delete(pubkey);
    }
  }
}
