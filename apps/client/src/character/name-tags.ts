/**
 * Name tags.
 * ==========
 *
 * Small labels floating above nearby players. In a world with no chat log and no friends
 * list, the name tag is how you tell who is who — but it is also the single easiest way
 * to ruin a calm scene, so this implementation is aggressively restrained:
 *
 * - only the nearest {@link MAX_TAGS} players get one;
 * - tags fade out with distance and disappear entirely past {@link FADE_END};
 * - they are drawn as sprites in the 3D scene, not as DOM nodes.
 *
 * ### Why sprites rather than DOM
 * The usual approach (`CSS2DRenderer`) puts one absolutely-positioned `<div>` per player
 * over the canvas. At sixty players that is sixty elements whose transforms are rewritten
 * every frame, which is enough layout churn to cost real frame time on a phone — and it
 * puts world content into the overlay layer, which this project deliberately keeps clear
 * for interface only.
 *
 * Sprites cost one draw call each and are occluded correctly by the world, which is what
 * you want: a name behind a building should not float in front of it.
 *
 * Textures are cached by name, so a hundred players called "Visitor" share one texture.
 */

import * as THREE from 'three';

/** Maximum simultaneous tags. Beyond this, a crowd becomes a wall of text. */
const MAX_TAGS = 18;

/** Distance at which tags begin to fade, and where they are gone entirely. */
const FADE_START = 22;
const FADE_END = 38;

/** Height above the character's feet, metres. Just above the head. */
const TAG_HEIGHT = 2.05;

/** Device-pixel scale for the label canvas. 2× keeps text crisp without wasting memory. */
const TEXTURE_SCALE = 2;

interface TagTarget {
  id: string;
  name: string;
  position: THREE.Vector3;
  /** Drawn in the accent colour — used for the host of a live activity. */
  highlight?: boolean;
}

/** One pooled sprite. */
interface Tag {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  /** Name currently rendered on this sprite's texture, so we only re-render on change. */
  renderedName: string | null;
  renderedHighlight: boolean;
}

export class NameTags {
  readonly group = new THREE.Group();

  private readonly pool: Tag[] = [];
  private readonly textures = new Map<string, THREE.CanvasTexture>();

  /** Toggled from settings. When false the whole group is simply hidden. */
  enabled = true;

  constructor() {
    this.group.name = 'name-tags';
    // Tags must not cast shadows or the plaza acquires floating rectangles of shade.
    this.group.matrixAutoUpdate = true;
  }

  /**
   * Render a texture for a name.
   *
   * Drawn as light text on a soft dark plate rather than the reverse: the island's sky
   * and sand are both pale, and dark-on-light labels vanish against them.
   */
  private textureFor(name: string, highlight: boolean): THREE.CanvasTexture {
    const key = `${highlight ? 'h:' : 'n:'}${name}`;
    const cached = this.textures.get(key);
    if (cached) return cached;

    const fontSize = 34;
    const padX = 18;
    const padY = 10;

    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) throw new Error('2D canvas context unavailable');
    measure.font = `500 ${fontSize}px -apple-system, "Segoe UI", "Hiragino Sans", sans-serif`;
    const width = Math.ceil(measure.measureText(name).width) + padX * 2;
    const height = fontSize + padY * 2;

    const canvas = document.createElement('canvas');
    canvas.width = width * TEXTURE_SCALE;
    canvas.height = height * TEXTURE_SCALE;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(TEXTURE_SCALE, TEXTURE_SCALE);

    // Plate: warm near-black at low opacity, fully rounded.
    ctx.fillStyle = highlight ? 'rgba(196, 80, 58, 0.88)' : 'rgba(38, 34, 30, 0.62)';
    const r = height / 2;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(width - r, 0);
    ctx.arcTo(width, 0, width, r, r);
    ctx.lineTo(width, height - r);
    ctx.arcTo(width, height, width - r, height, r);
    ctx.lineTo(r, height);
    ctx.arcTo(0, height, 0, height - r, r);
    ctx.lineTo(0, r);
    ctx.arcTo(0, 0, r, 0, r);
    ctx.fill();

    ctx.fillStyle = '#F6F2EA';
    ctx.font = `500 ${fontSize}px -apple-system, "Segoe UI", "Hiragino Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, width / 2, height / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    // Store the plate's aspect ratio so `update` can size the sprite without re-measuring.
    texture.userData.aspect = width / height;
    this.textures.set(key, texture);
    return texture;
  }

  /** Grow the pool on demand. Sprites are never destroyed, only hidden. */
  private acquire(index: number): Tag {
    let tag = this.pool[index];
    if (tag) return tag;

    const material = new THREE.SpriteMaterial({
      transparent: true,
      depthTest: true,
      // Depth writes off: overlapping tags should blend, not z-fight.
      depthWrite: false,
      // Tone mapping would dull the plate; tags are interface, not lit surface.
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = 5;
    this.group.add(sprite);

    tag = { sprite, material, renderedName: null, renderedHighlight: false };
    this.pool[index] = tag;
    return tag;
  }

  /**
   * Update every tag for this frame.
   *
   * `targets` may be any length; only the nearest {@link MAX_TAGS} within range are
   * drawn. Callers pass the whole population and let this method decide — the ranking is
   * a partial sort over a small array and is far cheaper than the alternative of every
   * caller maintaining its own nearby-player list.
   */
  update(targets: readonly TagTarget[], camera: THREE.Camera): void {
    if (!this.enabled) {
      if (this.group.visible) this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const cameraPos = camera.position;

    // Rank by distance, keeping only those inside the fade window.
    const ranked = targets
      .map((t) => ({ t, d: t.position.distanceTo(cameraPos) }))
      .filter((e) => e.d < FADE_END)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_TAGS);

    for (let i = 0; i < ranked.length; i++) {
      const { t, d } = ranked[i];
      const tag = this.acquire(i);

      // Only touch the texture when the label's content actually changed — creating a
      // CanvasTexture per frame would be a memory leak with a nice API.
      if (tag.renderedName !== t.name || tag.renderedHighlight !== (t.highlight ?? false)) {
        const texture = this.textureFor(t.name, t.highlight ?? false);
        tag.material.map = texture;
        tag.material.needsUpdate = true;
        tag.renderedName = t.name;
        tag.renderedHighlight = t.highlight ?? false;

        // Sprite scale is in world units; 0.42 m tall reads as a label rather than a
        // billboard at character scale.
        const aspect = (texture.userData.aspect as number) || 3;
        tag.sprite.scale.set(0.42 * aspect, 0.42, 1);
      }

      tag.sprite.position.set(t.position.x, t.position.y + TAG_HEIGHT, t.position.z);
      // Fade rather than pop. Squared falloff so tags thin out gently as a crowd recedes.
      const fade = 1 - Math.max(0, Math.min(1, (d - FADE_START) / (FADE_END - FADE_START)));
      tag.material.opacity = fade * fade;
      tag.sprite.visible = fade > 0.02;
    }

    // Retire any sprite the ranking no longer uses.
    for (let i = ranked.length; i < this.pool.length; i++) {
      if (this.pool[i]?.sprite.visible) this.pool[i].sprite.visible = false;
    }
  }

  dispose(): void {
    for (const tag of this.pool) {
      tag.material.dispose();
      tag.sprite.removeFromParent();
    }
    this.pool.length = 0;
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
  }
}
