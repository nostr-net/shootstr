/**
 * Wolfenstein 3D-style raycasting engine
 */

import { WeaponSprites } from './weapon-sprites';

export interface Player {
  x: number;
  y: number;
  angle: number;
  speed: number;
  rotSpeed: number;
}

export interface Sprite {
  x: number;
  y: number;
  texture: HTMLImageElement | HTMLCanvasElement;
  pubkey: string;
  name: string;
  health: number;
  maxHealth: number;
  lastPostTime?: number;
  vx: number; // velocity x
  vy: number; // velocity y
  state: 'idle' | 'walking' | 'dying' | 'dead';
  animationFrame: number;
  nextMoveTime: number;
}

export interface MapData {
  width: number;
  height: number;
  grid: number[][];
}

export class Raycaster {
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;

  public player: Player;
  public map: MapData;
  public sprites: Sprite[] = [];

  // Exit door callback
  private exitDoorCallback: (() => void) | null = null;
  private isInExitZone: boolean = false;

  // Raycasting parameters
  private readonly FOV = Math.PI / 3; // 60 degrees
  private readonly HALF_FOV = this.FOV / 2;
  private readonly TWO_PI = Math.PI * 2;
  private readonly SPRITE_HIT_ANGLE = 0.1;
  private readonly SPRITE_RENDER_FOV_PADDING = 0.2;
  private readonly SPRITE_COLLISION_DISTANCE_SQ = 0.09;
  private numRays: number;
  private readonly MAX_DEPTH = 20;
  private readonly MAX_DEPTH_SQ = this.MAX_DEPTH * this.MAX_DEPTH;
  private readonly MIN_RAYS = 240;
  private readonly MAX_RAYS = 640;
  private readonly RAY_STEP = 0.02;

  // Textures
  private wallTextures: Map<number, HTMLCanvasElement> = new Map();
  private floorColor = '#1a1a2e';
  private ceilingColor = '#0f0f1e';

  // Weapon animation
  private weaponFrames: {
    idle: CanvasImageSource;
    fire: CanvasImageSource[];
  } | null = null;
  private weaponFireFrameIndex: number = 0;
  private weaponAnimationTime: number = 0;
  private readonly weaponAnimationDuration = 200;
  private hitMarkers: Array<{x: number, y: number, alpha: number, time: number}> = [];
  private floorGradient: CanvasGradient | null = null;
  private rayData: Array<{ distance: number; wallType: number; textureX: number }> = [];
  private visibleSpritesBuffer: Array<{ sprite: Sprite; distanceSq: number }> = [];
  private rayCastScratch: { distance: number; wallType: number; textureX: number } = {
    distance: 0,
    wallType: 0,
    textureX: 0
  };

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;

    this.width = canvas.width;
    this.height = canvas.height;
    this.numRays = this.resolveRayCount(this.width);

    // Initialize player in center of larger map
    this.player = {
      x: 12.5,
      y: 12.5,
      angle: 0,
      speed: 0.05,
      rotSpeed: 0.03
    };

    // Initialize map
    this.map = this.createMap();

    // Create wall textures
    this.createWallTextures();

    // Load weapon sprites asynchronously
    WeaponSprites.createPistolFrames().then(frames => {
      this.weaponFrames = frames;
    }).catch(err => {
      console.error('Failed to load weapon sprites:', err);
    });
  }

  private createMap(): MapData {
    // Create a complex map with rooms, corridors, and obstacles
    // 0 = empty, 1-4 = different wall types, 5 = exit door
    const grid = [
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 0, 0, 0, 1],
      [1, 0, 3, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 4, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 2, 0, 0, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 2, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1],
      [1, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 4, 0, 0, 2, 2, 2, 2, 2, 0, 0, 3, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 1],
      [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 5, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    ];

    return {
      width: grid[0].length,
      height: grid.length,
      grid
    };
  }

  private createWallTextures(): void {
    // Create procedural wall textures
    const createTexture = (baseColor: string, accentColor: string) => {
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d')!;

      // Base color
      ctx.fillStyle = baseColor;
      ctx.fillRect(0, 0, size, size);

      // Add some detail (brick-like pattern)
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1;

      // Horizontal lines
      for (let i = 0; i < size; i += 16) {
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(size, i);
        ctx.stroke();
      }

      // Vertical lines (offset every other row)
      for (let y = 0; y < size; y += 16) {
        const offset = (y / 16) % 2 === 0 ? 0 : size / 2;
        for (let x = offset; x < size + offset; x += size / 2) {
          ctx.beginPath();
          ctx.moveTo(x % size, y);
          ctx.lineTo(x % size, y + 16);
          ctx.stroke();
        }
      }

      return canvas;
    };

    this.wallTextures.set(1, createTexture('#2d2d44', '#1a1a2e'));
    this.wallTextures.set(2, createTexture('#3d2d44', '#2a1a2e'));
    this.wallTextures.set(3, createTexture('#2d3d44', '#1a2a2e'));
    this.wallTextures.set(4, createTexture('#442d3d', '#2e1a2a'));

    // Create EXIT door texture (bright green with EXIT text)
    const exitTexture = document.createElement('canvas');
    exitTexture.width = 64;
    exitTexture.height = 64;
    const exitCtx = exitTexture.getContext('2d')!;
    exitCtx.fillStyle = '#00ff00';
    exitCtx.fillRect(0, 0, 64, 64);
    exitCtx.fillStyle = '#000';
    exitCtx.font = 'bold 16px monospace';
    exitCtx.textAlign = 'center';
    exitCtx.fillText('EXIT', 32, 32);
    this.wallTextures.set(5, exitTexture);
  }

  public setViewportSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.numRays = this.resolveRayCount(width);
    this.floorGradient = null;
  }

  public render(deltaMs: number = 16): void {
    // Clear canvas
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Render ceiling and floor
    this.renderFloorAndCeiling();

    // Cast rays for walls
    const rayData = this.castRays();

    // Render walls
    this.renderWalls(rayData);

    // Render sprites
    this.renderSprites(rayData);

    // Render hit markers
    this.renderHitMarkers();

    // Render weapon (pistol)
    this.renderWeapon();

    // Update weapon animation
    this.updateWeaponAnimation(Math.max(0, deltaMs));
  }

  private renderFloorAndCeiling(): void {
    const halfHeight = this.height / 2;

    // Ceiling
    this.ctx.fillStyle = this.ceilingColor;
    this.ctx.fillRect(0, 0, this.width, halfHeight);

    // Floor with gradient
    if (!this.floorGradient) {
      this.floorGradient = this.ctx.createLinearGradient(0, halfHeight, 0, this.height);
      this.floorGradient.addColorStop(0, this.floorColor);
      this.floorGradient.addColorStop(1, '#0a0a14');
    }
    this.ctx.fillStyle = this.floorGradient;
    this.ctx.fillRect(0, halfHeight, this.width, halfHeight);
  }

  private castRays(): Array<{distance: number, wallType: number, textureX: number}> {
    const rayData = this.rayData;
    const numRays = this.numRays;
    const angleStart = this.player.angle - this.HALF_FOV;
    const angleStep = this.FOV / numRays;

    if (rayData.length < numRays) {
      for (let i = rayData.length; i < numRays; i++) {
        rayData.push({ distance: 0, wallType: 0, textureX: 0 });
      }
    }

    let rayAngle = angleStart;
    for (let i = 0; i < numRays; i++) {
      const slot = rayData[i];
      this.castRay(rayAngle, slot);
      rayAngle += angleStep;
    }

    rayData.length = numRays;
    return rayData;
  }

  private castRay(
    angle: number,
    output?: { distance: number; wallType: number; textureX: number }
  ): { distance: number; wallType: number; textureX: number } {
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const map = this.map;
    const mapWidth = map.width;
    const mapHeight = map.height;
    const grid = map.grid;

    let distance = 0;
    let hitWall = false;
    let wallType = 0;
    let textureX = 0;

    while (!hitWall && distance < this.MAX_DEPTH) {
      distance += this.RAY_STEP;

      const x = this.player.x + cos * distance;
      const y = this.player.y + sin * distance;

      const mapX = Math.floor(x);
      const mapY = Math.floor(y);

      // Check bounds
      if (mapX < 0 || mapX >= mapWidth || mapY < 0 || mapY >= mapHeight) {
        hitWall = true;
        wallType = 1;
      } else if (grid[mapY][mapX] > 0 && grid[mapY][mapX] !== 5) {
        hitWall = true;
        wallType = grid[mapY][mapX];

        // Calculate texture X coordinate
        const hitX = x - mapX;
        const hitY = y - mapY;

        if (hitX < 0.01 || hitX > 0.99) {
          textureX = hitY;
        } else {
          textureX = hitX;
        }
        textureX = textureX % 1;
      }
    }

    // Fix fish-eye effect
    distance *= Math.cos(angle - this.player.angle);

    if (output) {
      output.distance = distance;
      output.wallType = wallType;
      output.textureX = textureX;
      return output;
    }

    return { distance, wallType, textureX };
  }

  private normalizeAngleDiff(angleDiff: number): number {
    if (angleDiff > Math.PI) {
      angleDiff -= this.TWO_PI;
    } else if (angleDiff < -Math.PI) {
      angleDiff += this.TWO_PI;
    }

    return angleDiff;
  }

  private renderWalls(rayData: Array<{distance: number, wallType: number, textureX: number}>): void {
    const stripWidth = this.width / this.numRays;
    const previousAlpha = this.ctx.globalAlpha;

    for (let i = 0; i < rayData.length; i++) {
      const { distance, wallType, textureX } = rayData[i];

      if (distance < this.MAX_DEPTH) {
        // Calculate wall height
        const wallHeight = (this.height / distance) * 0.5;
        const top = (this.height - wallHeight) / 2;

        // Apply distance shading
        const brightness = Math.max(0.2, 1 - distance / this.MAX_DEPTH);

        // Get wall texture
        const texture = this.wallTextures.get(wallType);

        if (texture) {
          const srcX = Math.floor(textureX * texture.width);

          // Apply brightness
          this.ctx.globalAlpha = brightness;

          // Draw textured wall strip
          this.ctx.drawImage(
            texture,
            srcX, 0, 1, texture.height,
            i * stripWidth, top, stripWidth + 1, wallHeight
          );
        } else {
          // Fallback to solid color
          this.ctx.fillStyle = `rgba(100, 100, 150, ${brightness})`;
          this.ctx.fillRect(i * stripWidth, top, stripWidth, wallHeight);
        }
      }
    }

    this.ctx.globalAlpha = previousAlpha;
  }

  private renderSprites(rayData: Array<{distance: number}>): void {
    const visibleSprites = this.visibleSpritesBuffer;
    visibleSprites.length = 0;

    for (const sprite of this.sprites) {
      if (sprite.state === 'dead') {
        continue;
      }

      const dx = sprite.x - this.player.x;
      const dy = sprite.y - this.player.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > this.MAX_DEPTH_SQ) {
        continue;
      }

      visibleSprites.push({
        sprite,
        distanceSq
      });
    }

    visibleSprites.sort((a, b) => b.distanceSq - a.distanceSq);

    for (const { sprite, distanceSq } of visibleSprites) {
      const distance = Math.sqrt(distanceSq);

      // Calculate sprite angle relative to player
      const spriteAngle = Math.atan2(sprite.y - this.player.y, sprite.x - this.player.x);
      const angleDiff = this.normalizeAngleDiff(spriteAngle - this.player.angle);

      // Check if sprite is in FOV
      if (Math.abs(angleDiff) > this.HALF_FOV + this.SPRITE_RENDER_FOV_PADDING) continue;

      // Calculate sprite screen position
      const screenX = (angleDiff / this.FOV + 0.5) * this.width;

      // Calculate sprite size
      const spriteHeight = (this.height / distance) * 0.8;
      const spriteWidth = spriteHeight;

      const top = (this.height - spriteHeight) / 2;
      const left = screenX - spriteWidth / 2;

      // Check if sprite is behind a wall
      const spriteColumn = Math.floor(screenX);
      if (spriteColumn >= 0 && spriteColumn < rayData.length) {
        if (rayData[spriteColumn].distance < distance) {
          continue; // Behind a wall
        }
      }

      // Apply distance shading
      const brightness = Math.max(0.3, 1 - distance / this.MAX_DEPTH);

      // Draw sprite
      const previousAlpha = this.ctx.globalAlpha;
      this.ctx.globalAlpha = brightness;

      // Check if texture is an image and if it's loaded
      const isImage = sprite.texture instanceof HTMLImageElement;
      const isLoaded = isImage && (sprite.texture as HTMLImageElement).complete && (sprite.texture as HTMLImageElement).naturalWidth > 0;

      if (sprite.texture && (!isImage || isLoaded)) {
        this.ctx.drawImage(
          sprite.texture,
          left, top,
          spriteWidth, spriteHeight
        );
      } else {
        // Fallback: draw colored circle with initial
        this.ctx.fillStyle = '#ff6600';
        this.ctx.beginPath();
        this.ctx.arc(screenX, this.height / 2, spriteWidth / 3, 0, Math.PI * 2);
        this.ctx.fill();

        // Draw initial letter
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = `bold ${spriteWidth / 4}px monospace`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        const initial = sprite.name?.charAt(0)?.toUpperCase() || '?';
        this.ctx.fillText(initial, screenX, this.height / 2);
      }

      this.ctx.globalAlpha = previousAlpha;

      // Draw name above sprite
      if (sprite.name) {
        const nameY = top - 25;

        this.ctx.save();
        this.ctx.font = `${Math.max(12, spriteWidth * 0.15)}px monospace`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'bottom';

        // Name shadow/outline for better visibility
        this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        this.ctx.lineWidth = 3;
        this.ctx.strokeText(sprite.name, screenX, nameY);

        // Name text
        this.ctx.fillStyle = '#00ff00';
        this.ctx.fillText(sprite.name, screenX, nameY);
        this.ctx.restore();
      }

      // Draw health bar above sprite
      if (sprite.health > 0) {
        const barWidth = spriteWidth * 0.8;
        const barHeight = 4;
        const barX = left + (spriteWidth - barWidth) / 2;
        const barY = top - 10;

        // Background
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this.ctx.fillRect(barX, barY, barWidth, barHeight);

        // Health
        const healthPercent = sprite.health / sprite.maxHealth;
        const healthColor = healthPercent > 0.5 ? '#00ff00' : healthPercent > 0.25 ? '#ffff00' : '#ff0000';
        this.ctx.fillStyle = healthColor;
        this.ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);

        // Draw last posted label next to health bar
        this.ctx.save();
        this.ctx.font = `${Math.max(10, spriteWidth * 0.12)}px monospace`;
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'middle';

        const postLabel = this.formatLastPosted(sprite.lastPostTime);
        const textMetrics = this.ctx.measureText(postLabel);
        const textX = barX + barWidth + 5;
        const textY = barY + barHeight / 2;

        // Background for better visibility
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this.ctx.fillRect(textX - 2, textY - 8, textMetrics.width + 4, 16);

        // Last posted text
        this.ctx.fillStyle = '#00ffff';
        this.ctx.fillText(postLabel, textX, textY);
        this.ctx.restore();
      }
    }
  }

  public movePlayer(forward: number, strafe: number): void {
    const sin = Math.sin(this.player.angle);
    const cos = Math.cos(this.player.angle);

    // Forward/backward movement
    let newX = this.player.x + cos * forward * this.player.speed;
    let newY = this.player.y + sin * forward * this.player.speed;

    // Strafe movement (perpendicular to forward direction)
    // Right strafe is 90 degrees clockwise from forward: (-sin, cos)
    newX += -sin * strafe * this.player.speed;
    newY += cos * strafe * this.player.speed;

    // Collision detection with walls and sprites
    // Try to move to the new position
    if (!this.checkCollision(newX, newY) && this.checkSpriteCollision(newX, newY)) {
      // Can move to the new position directly
      this.player.x = newX;
      this.player.y = newY;
    } else {
      // Try sliding along walls - attempt X and Y movement separately
      if (!this.checkCollision(newX, this.player.y) && this.checkSpriteCollision(newX, this.player.y)) {
        this.player.x = newX;
      }
      if (!this.checkCollision(this.player.x, newY) && this.checkSpriteCollision(this.player.x, newY)) {
        this.player.y = newY;
      }
    }
  }

  public rotatePlayer(direction: number): void {
    this.player.angle += direction * this.player.rotSpeed;

    // Normalize angle
    if (this.player.angle > this.TWO_PI) {
      this.player.angle -= this.TWO_PI;
    } else if (this.player.angle < 0) {
      this.player.angle += this.TWO_PI;
    }
  }

  private formatLastPosted(timestamp?: number): string {
    if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return 'No post data';
    const days = Math.floor((Date.now() / 1000 - timestamp) / 86400);
    if (days < 1) return 'Today';
    if (days === 1) return '1d ago';
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(months / 12);
    return `${years}y ago`;
  }

  private checkCollision(x: number, y: number): boolean {
    // Check collision with buffer to prevent clipping through walls
    const buffer = 0.2;
    const mapWidth = this.map.width;
    const mapHeight = this.map.height;
    const grid = this.map.grid;

    // Top right
    let mapX = Math.floor(x + buffer);
    let mapY = Math.floor(y + buffer);
    if (mapX < 0 || mapX >= mapWidth || mapY < 0 || mapY >= mapHeight) {
      return true;
    }
    if (grid[mapY][mapX] > 0 && grid[mapY][mapX] !== 5) {
      return true;
    }

    // Bottom right
    mapX = Math.floor(x + buffer);
    mapY = Math.floor(y - buffer);
    if (mapX < 0 || mapX >= mapWidth || mapY < 0 || mapY >= mapHeight) {
      return true;
    }
    if (grid[mapY][mapX] > 0 && grid[mapY][mapX] !== 5) {
      return true;
    }

    // Bottom left
    mapX = Math.floor(x - buffer);
    mapY = Math.floor(y - buffer);
    if (mapX < 0 || mapX >= mapWidth || mapY < 0 || mapY >= mapHeight) {
      return true;
    }
    if (grid[mapY][mapX] > 0 && grid[mapY][mapX] !== 5) {
      return true;
    }

    // Top left
    mapX = Math.floor(x - buffer);
    mapY = Math.floor(y + buffer);
    if (mapX < 0 || mapX >= mapWidth || mapY < 0 || mapY >= mapHeight) {
      return true;
    }
    if (grid[mapY][mapX] > 0 && grid[mapY][mapX] !== 5) {
      return true;
    }

    return false;
  }

  private checkSpriteCollision(x: number, y: number): boolean {
    for (const sprite of this.sprites) {
      if (sprite.state === 'dead' || sprite.state === 'dying') continue;

      const dx = sprite.x - x;
      const dy = sprite.y - y;
      const distanceSq = dx * dx + dy * dy;

      if (distanceSq < this.SPRITE_COLLISION_DISTANCE_SQ) {
        return false; // Collision detected
      }
    }

    return true; // No collision
  }

  public shootRay(): Sprite | null {
    // Cast ray from center of screen
    const rayResult = this.castRay(this.player.angle, this.rayCastScratch);
    const rayDistanceSq = rayResult.distance * rayResult.distance;
    let closestSprite: Sprite | null = null;
    let closestDistanceSq = rayDistanceSq;

    // Check if we hit any sprite
    for (const sprite of this.sprites) {
      if (sprite.state === 'dead' || sprite.state === 'dying') {
        continue;
      }

      const dx = sprite.x - this.player.x;
      const dy = sprite.y - this.player.y;
      const distanceSq = dx * dx + dy * dy;

      if (distanceSq >= closestDistanceSq) {
        continue;
      }

      const spriteAngle = Math.atan2(dy, dx);
      const angleDiff = Math.abs(this.normalizeAngleDiff(spriteAngle - this.player.angle));
      if (angleDiff >= this.SPRITE_HIT_ANGLE) {
        continue;
      }

      closestDistanceSq = distanceSq;
      closestSprite = sprite;
    }

    return closestSprite;
  }

  public updateSprites(deltaTime: number): void {
    const now = Date.now();

    for (const sprite of this.sprites) {
      if (sprite.state === 'dead') continue;

      if (sprite.state === 'dying') {
        // Fade out animation
        sprite.animationFrame += deltaTime * 0.01;
        if (sprite.animationFrame >= 1) {
          sprite.state = 'dead';
        }
        continue;
      }

      // Random movement AI
      if (now >= sprite.nextMoveTime) {
        // Choose new direction
        const angle = Math.random() * Math.PI * 2;
        const speed = 0.02;
        sprite.vx = Math.cos(angle) * speed;
        sprite.vy = Math.sin(angle) * speed;
        sprite.state = 'walking';
        sprite.nextMoveTime = now + 1000 + Math.random() * 2000;
      }

      // Move sprite
      if (sprite.state === 'walking') {
        const newX = sprite.x + sprite.vx;
        const newY = sprite.y + sprite.vy;

        // Check collision with walls
        if (!this.checkCollision(newX, newY)) {
          // Check collision with player
          const dx = newX - this.player.x;
          const dy = newY - this.player.y;
          const distToPlayerSq = dx * dx + dy * dy;

          if (distToPlayerSq > this.SPRITE_COLLISION_DISTANCE_SQ) {
            sprite.x = newX;
            sprite.y = newY;
          } else {
            // Hit player, stop moving
            sprite.vx = 0;
            sprite.vy = 0;
            sprite.state = 'idle';
            sprite.nextMoveTime = now;
          }
        } else {
          // Hit wall, stop moving
          sprite.vx = 0;
          sprite.vy = 0;
          sprite.state = 'idle';
          sprite.nextMoveTime = now;
        }
      }
    }
  }

  public addSprite(sprite: Sprite): void {
    this.sprites.push(sprite);
  }

  public removeSprite(pubkey: string): void {
    const index = this.sprites.findIndex(s => s.pubkey === pubkey);
    if (index !== -1) {
      this.sprites.splice(index, 1);
    }
  }

  private renderWeapon(): void {
    // Check if weapon frames are loaded
    if (!this.weaponFrames) {
      return; // Weapon not loaded yet
    }

    // Get current weapon frame
    const frame = this.selectWeaponFrame();

    // Calculate weapon size and position
    // Scale weapon to take up about 1/3 of screen width for proper proportion
    const weaponWidth = this.width * 0.35;
    const weaponHeight = weaponWidth; // Keep square aspect ratio

    // Position at bottom center of screen
    const weaponX = this.width / 2 - weaponWidth / 2;
    const weaponY = this.height - weaponHeight * 0.85; // Show more of the weapon

    this.ctx.save();
    this.ctx.imageSmoothingEnabled = true; // Enable smoothing for the photo-realistic gun

    // Draw the weapon sprite
    this.ctx.drawImage(
      frame,
      weaponX,
      weaponY,
      weaponWidth,
      weaponHeight
    );

    this.ctx.restore();
  }

  private renderHitMarkers(): void {
    const now = Date.now();

    // Update and render hit markers
    this.hitMarkers = this.hitMarkers.filter(marker => {
      const age = now - marker.time;
      if (age > 500) return false;

      marker.alpha = 1 - (age / 500);

      this.ctx.save();
      this.ctx.globalAlpha = marker.alpha;

      // Red blood splatter
      this.ctx.fillStyle = '#ff0000';
      const size = 20 + (age / 10);

      // Draw splatter pattern
      for (let i = 0; i < 8; i++) {
        const angle = (Math.PI * 2 / 8) * i;
        const distance = size * (0.5 + Math.random() * 0.5);
        const splatX = marker.x + Math.cos(angle) * distance;
        const splatY = marker.y + Math.sin(angle) * distance;

        this.ctx.beginPath();
        this.ctx.arc(splatX, splatY, 3 + Math.random() * 3, 0, Math.PI * 2);
        this.ctx.fill();
      }

      // Center impact
      this.ctx.fillStyle = '#cc0000';
      this.ctx.beginPath();
      this.ctx.arc(marker.x, marker.y, 8, 0, Math.PI * 2);
      this.ctx.fill();

      this.ctx.restore();
      return true;
    });
  }

  public triggerShot(): void {
    this.weaponFireFrameIndex = 0;
    this.weaponAnimationTime = this.weaponAnimationDuration;
  }

  private updateWeaponAnimation(deltaMs: number): void {
    if (!this.weaponFrames || this.weaponAnimationTime <= 0) {
      return;
    }

    this.weaponAnimationTime = Math.max(0, this.weaponAnimationTime - deltaMs);

    const fireFrames = this.weaponFrames.fire;
    if (fireFrames.length <= 1) {
      this.weaponFireFrameIndex = 0;
      return;
    }

    const elapsed = this.weaponAnimationDuration - this.weaponAnimationTime;
    const frameDuration = this.weaponAnimationDuration / fireFrames.length;
    this.weaponFireFrameIndex = Math.min(
      fireFrames.length - 1,
      Math.floor(elapsed / frameDuration)
    );

    if (this.weaponAnimationTime === 0) {
      this.weaponFireFrameIndex = 0;
    }
  }

  private selectWeaponFrame(): CanvasImageSource {
    if (!this.weaponFrames) {
      throw new Error('Weapon frames not loaded');
    }

    if (this.weaponAnimationTime > 0 && this.weaponFrames.fire.length > 0) {
      const index = Math.min(
        this.weaponFireFrameIndex,
        this.weaponFrames.fire.length - 1
      );
      return this.weaponFrames.fire[index];
    }

    return this.weaponFrames.idle;
  }

  public addHitMarker(sprite: Sprite): void {
    // Calculate sprite screen position for hit marker
    const spriteAngle = Math.atan2(sprite.y - this.player.y, sprite.x - this.player.x);
    let angleDiff = spriteAngle - this.player.angle;

    // Normalize angle
    angleDiff = this.normalizeAngleDiff(angleDiff);

    const screenX = (angleDiff / this.FOV + 0.5) * this.width;
    const screenY = this.height / 2;

    this.hitMarkers.push({
      x: screenX,
      y: screenY,
      alpha: 1,
      time: Date.now()
    });
  }

  /**
   * Set callback for when player enters exit door zone
   */
  public setExitDoorCallback(callback: () => void): void {
    this.exitDoorCallback = callback;
  }

  /**
   * Check if player is currently in an exit door zone
   */
  public checkExitDoorZone(): void {
    const mapX = Math.floor(this.player.x);
    const mapY = Math.floor(this.player.y);

    if (mapX >= 0 && mapX < this.map.width && mapY >= 0 && mapY < this.map.height) {
      const cellType = this.map.grid[mapY][mapX];

      if (cellType === 5 && !this.isInExitZone) {
        // Player just entered exit zone
        this.isInExitZone = true;
        if (this.exitDoorCallback) {
          this.exitDoorCallback();
        }
      } else if (cellType !== 5 && this.isInExitZone) {
        // Player left exit zone
        this.isInExitZone = false;
      }
    }
  }

  private resolveRayCount(viewportWidth: number): number {
    const raysByWidth = Math.floor(viewportWidth / 4);
    return Math.max(this.MIN_RAYS, Math.min(this.MAX_RAYS, raysByWidth));
  }
}
