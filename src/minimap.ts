/**
 * Minimap renderer for displaying map layout and player position
 */

import { MapData, Player, Sprite } from './raycaster';

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private mapCacheCanvas: HTMLCanvasElement;
  private mapCacheCtx: CanvasRenderingContext2D;
  private cachedMapWidth: number = 0;
  private cachedMapHeight: number = 0;

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!this.canvas) {
      throw new Error(`Canvas with id "${canvasId}" not found`);
    }

    this.ctx = this.canvas.getContext('2d')!;
    this.width = this.canvas.width = 200;
    this.height = this.canvas.height = 200;

    this.mapCacheCanvas = document.createElement('canvas');
    this.mapCacheCanvas.width = this.width;
    this.mapCacheCanvas.height = this.height;
    this.mapCacheCtx = this.mapCacheCanvas.getContext('2d')!;
  }

  public render(map: MapData, player: Player, sprites: Sprite[]): void {
    // Calculate tile size based on map dimensions
    const tileWidth = this.width / map.width;
    const tileHeight = this.height / map.height;

    if (map.width !== this.cachedMapWidth || map.height !== this.cachedMapHeight) {
      this.renderStaticMap(map, tileWidth, tileHeight);
      this.cachedMapWidth = map.width;
      this.cachedMapHeight = map.height;
    }

    // Render precomputed map
    this.ctx.drawImage(this.mapCacheCanvas, 0, 0);

    // Render sprites (enemies)
    this.renderSprites(sprites, tileWidth, tileHeight);

    // Render player
    this.renderPlayer(player, tileWidth, tileHeight);
  }

  private renderStaticMap(map: MapData, tileWidth: number, tileHeight: number): void {
    const ctx = this.mapCacheCtx;

    // Clear cache canvas
    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.strokeStyle = 'rgba(15, 15, 30, 0.5)';
    ctx.lineWidth = 0.5;

    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const tile = map.grid[y][x];
        const screenX = x * tileWidth;
        const screenY = y * tileHeight;

        if (tile === 5) {
          // Exit door (save room) - marked in yellow/gold
          ctx.fillStyle = '#ffd700';
          ctx.fillRect(screenX, screenY, tileWidth, tileHeight);
        } else if (tile > 0) {
          // Wall
          ctx.fillStyle = this.getWallColor(tile);
          ctx.fillRect(screenX, screenY, tileWidth, tileHeight);
        } else {
          // Floor (empty space)
          ctx.fillStyle = '#1a1a2e';
          ctx.fillRect(screenX, screenY, tileWidth, tileHeight);
        }

        // Draw grid lines for better visibility
        ctx.strokeRect(screenX, screenY, tileWidth, tileHeight);
      }
    }
  }

  private getWallColor(wallType: number): string {
    // Different colors for different wall types
    switch (wallType) {
      case 1:
        return '#2d2d44';
      case 2:
        return '#3d2d44';
      case 3:
        return '#2d3d44';
      case 4:
        return '#442d3d';
      default:
        return '#2d2d44';
    }
  }

  private renderSprites(sprites: Sprite[], tileWidth: number, tileHeight: number): void {
    for (const sprite of sprites) {
      if (sprite.state === 'dead') continue;

      const screenX = sprite.x * tileWidth;
      const screenY = sprite.y * tileHeight;

      // Draw sprite as a small red dot
      this.ctx.fillStyle = sprite.state === 'dying' ? '#ff000080' : '#ff0000';
      this.ctx.beginPath();
      this.ctx.arc(screenX, screenY, Math.max(2, tileWidth * 0.3), 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  private renderPlayer(player: Player, tileWidth: number, tileHeight: number): void {
    const screenX = player.x * tileWidth;
    const screenY = player.y * tileHeight;

    // Draw player as a green dot
    this.ctx.fillStyle = '#00ff00';
    this.ctx.beginPath();
    this.ctx.arc(screenX, screenY, Math.max(3, tileWidth * 0.4), 0, Math.PI * 2);
    this.ctx.fill();

    // Draw direction indicator
    const dirLength = tileWidth * 1.5;
    const dirX = screenX + Math.cos(player.angle) * dirLength;
    const dirY = screenY + Math.sin(player.angle) * dirLength;

    this.ctx.strokeStyle = '#00ff00';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(screenX, screenY);
    this.ctx.lineTo(dirX, dirY);
    this.ctx.stroke();

    // Draw FOV cone
    const fov = Math.PI / 3; // 60 degrees FOV
    const fovLength = tileWidth * 2;

    this.ctx.strokeStyle = 'rgba(0, 255, 0, 0.3)';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(screenX, screenY);
    this.ctx.lineTo(
      screenX + Math.cos(player.angle - fov / 2) * fovLength,
      screenY + Math.sin(player.angle - fov / 2) * fovLength
    );
    this.ctx.moveTo(screenX, screenY);
    this.ctx.lineTo(
      screenX + Math.cos(player.angle + fov / 2) * fovLength,
      screenY + Math.sin(player.angle + fov / 2) * fovLength
    );
    this.ctx.stroke();
  }
}
