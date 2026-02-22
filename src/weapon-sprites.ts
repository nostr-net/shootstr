/**
 * Weapon sprite loader
 * Loads the weapon image for use in the game
 */

export class WeaponSprites {
  private static animatedGunImage: HTMLImageElement | null = null;
  private static animatedLoadPromise: Promise<HTMLImageElement> | null = null;
  private static animatedFrames: CanvasImageSource[] | null = null;
  private static animatedFramesPromise: Promise<CanvasImageSource[] | null> | null = null;
  private static idleSnapshot: HTMLCanvasElement | null = null;
  private static readonly ANIMATED_GUN_PATH = '/Animated_Pistol.webp';

  private static loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load ${src}`));
      img.src = src;
    });
  }

  private static async loadAnimatedFrames(): Promise<CanvasImageSource[] | null> {
    if (this.animatedFrames) {
      return this.animatedFrames;
    }

    if (this.animatedFramesPromise) {
      return this.animatedFramesPromise;
    }

    const ImageDecoderCtor = (globalThis as { ImageDecoder?: typeof ImageDecoder }).ImageDecoder;
    if (!ImageDecoderCtor) {
      return null;
    }

    this.animatedFramesPromise = (async () => {
      let decoder: ImageDecoder | null = null;
      const decodedImages: Array<VideoFrame | ImageBitmap> = [];

      try {
        const response = await fetch(this.ANIMATED_GUN_PATH);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        decoder = new ImageDecoderCtor({ data: buffer, type: 'image/webp' });
        // Absorb internal rejection when decoder closes
        decoder?.completed?.catch?.(() => {});
        const frameCount = decoder?.tracks?.selectedTrack?.frameCount ?? 0;

        if (!frameCount) {
          return null;
        }

        const frames: HTMLCanvasElement[] = [];

        for (let i = 0; i < frameCount; i++) {
          try {
            const result = await decoder.decode({ frameIndex: i });
            const image = result?.image;
            if (!image) continue;

            const canvas = document.createElement('canvas');
            canvas.width = image.displayWidth;
            canvas.height = image.displayHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(image, 0, 0);
              frames.push(canvas);
            }

            decodedImages.push(image);
          } catch (_) {
            break; // decoder closed or frame unavailable
          }
        }

        if (frames.length > 0) {
          this.animatedFrames = frames;
          return frames;
        }

        return null;
      } catch (error) {
        console.warn('[WeaponSprites] Failed to decode animated pistol', error);
        return null;
      } finally {
        // Close VideoFrame images (they hold GPU resources).
        // Don't close the decoder explicitly — it fires async internal
        // rejections that can't be caught. Let GC handle it.
        for (const image of decodedImages) {
          try { image?.close?.(); } catch (_) { /* already closed */ }
        }

        this.animatedFramesPromise = null;
      }
    })();

    return this.animatedFramesPromise;
  }

  private static async loadAnimatedGunImage(): Promise<HTMLImageElement> {
    if (this.animatedGunImage) {
      return this.animatedGunImage;
    }

    if (this.animatedLoadPromise) {
      return this.animatedLoadPromise;
    }

    this.animatedLoadPromise = this.loadImage(this.ANIMATED_GUN_PATH).then((img) => {
      this.animatedGunImage = img;
      return img;
    });

    return this.animatedLoadPromise;
  }

  /**
   * Creates all pistol animation frames using the loaded gun image
   */
  public static async createPistolFrames(): Promise<{
    idle: CanvasImageSource;
    fire: CanvasImageSource[];
  }> {
    const animatedGunImage = await this.loadAnimatedGunImage();
    const animatedFrames = await this.loadAnimatedFrames();

    if (animatedFrames && animatedFrames.length > 1) {
      const [idle, ...fireFrames] = animatedFrames;
      return {
        idle,
        fire: fireFrames.length > 0 ? fireFrames : [idle],
      };
    }

    let idleSnapshot = this.idleSnapshot;
    if (!idleSnapshot) {
      const canvas = document.createElement('canvas');
      canvas.width = animatedGunImage.naturalWidth || animatedGunImage.width;
      canvas.height = animatedGunImage.naturalHeight || animatedGunImage.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(animatedGunImage, 0, 0);
      }
      this.idleSnapshot = canvas;
      idleSnapshot = canvas;
    }

    return {
      idle: idleSnapshot,
      fire: [animatedGunImage],
    };
  }

}
