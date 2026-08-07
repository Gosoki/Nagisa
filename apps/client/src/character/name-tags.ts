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

/**
 * Speech carries further than names.
 *
 * A name is a convenience: if you cannot read it, nothing is lost. A line someone just
 * said is *addressed* to the room, and having it silently not exist past 38 m makes the
 * island feel like six separate rooms. So bubbles keep their own, longer fade window and
 * their own, larger budget.
 */
const BUBBLE_FADE_START = 34;
const BUBBLE_FADE_END = 62;
const MAX_BUBBLES = 12;

/** Height of the bubble above the character's feet — clear of the name plate below it. */
const BUBBLE_HEIGHT = 2.52;

/** Height above the character's feet, metres. Just above the head. */
const TAG_HEIGHT = 2.05;

/** Device-pixel scale for the label canvas. 2× keeps text crisp without wasting memory. */
const TEXTURE_SCALE = 2;

/** Maximum wrapped lines in a bubble, and the height of its tail in canvas pixels. */
const BUBBLE_LINES = 3;
const TAIL_HEIGHT = 12;

interface TagTarget {
  id: string;
  name: string;
  position: THREE.Vector3;
  /** Drawn in the accent colour — used for the host of a live activity. */
  highlight?: boolean;
  /** What this player is currently saying, if anything. See `speech.ts`. */
  bubble?: string | null;
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
  private readonly bubblePool: Tag[] = [];
  /**
   * Rendered plates and bubbles, by content.
   *
   * **Bounded, and it was not.** Bubble textures are keyed on the *text of the message*, so
   * every distinct line anyone said left a canvas texture behind for the life of the page —
   * a few hundred kilobytes of GPU memory per sentence, in a room whose entire purpose is
   * people saying things. A long evening in a busy room is a leak measured in hundreds of
   * megabytes, and the first symptom is the context loss the loader has a handler for.
   *
   * Least-recently-used, evicted on insert. The caps are far above the number that can be on
   * screen at once — a handful of bubbles, a few dozen name plates — so eviction only ever
   * reaches textures nothing is drawing, and `update` re-renders on the next frame anyway if
   * it is wrong about that.
   */
  private readonly textures = new Map<string, THREE.CanvasTexture>();

  /** Distinct name plates kept. Names churn slowly; this is generous. */
  private static readonly NAME_CACHE = 128;

  /** Distinct speech bubbles kept. Only a handful are ever visible together. */
  private static readonly BUBBLE_CACHE = 64;

  /**
   * Store a texture, disposing the oldest of its kind once the cache is full.
   *
   * `Map` iterates in insertion order, so the first matching key is the least recently
   * *written*. Re-reading a cached texture does not refresh it, which is the cheap
   * approximation: a phrase said once an hour ago and a phrase said constantly both age out
   * eventually, and the cost of being wrong is one canvas redraw.
   */
  private remember(key: string, texture: THREE.CanvasTexture, prefix: string, cap: number): THREE.CanvasTexture {
    this.textures.set(key, texture);
    let live = 0;
    for (const k of this.textures.keys()) if (k.startsWith(prefix)) live++;
    for (const k of this.textures.keys()) {
      if (live <= cap) break;
      if (!k.startsWith(prefix)) continue;
      this.textures.get(k)?.dispose();
      this.textures.delete(k);
      live--;
    }
    return texture;
  }

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
    return this.remember(key, texture, key.slice(0, 2), NameTags.NAME_CACHE);
  }

  /**
   * Render a texture for a spoken line.
   *
   * Inverted from the name plate — dark ink on warm paper — because that is how speech is
   * drawn in the medium this whole renderer is imitating, and because it separates *who*
   * from *what* at a glance without needing to read either. Wrapped to at most
   * {@link BUBBLE_LINES} lines; `speech.ts` has already truncated anything longer.
   */
  private bubbleTextureFor(text: string): THREE.CanvasTexture {
    const key = `b:${text}`;
    const cached = this.textures.get(key);
    if (cached) return cached;

    const fontSize = 30;
    const lineHeight = 38;
    const padX = 20;
    const padY = 14;
    const maxWidth = 340;
    const font = `500 ${fontSize}px -apple-system, "Segoe UI", "Hiragino Sans", sans-serif`;

    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) throw new Error('2D canvas context unavailable');
    measure.font = font;

    // Greedy wrap. Breaks on spaces where there are any and per-character where there are
    // not, which is what CJK needs — a Japanese line has no spaces to break on at all.
    const lines: string[] = [];
    let current = '';
    const atoms = /\s/.test(text) ? text.split(/(\s+)/) : [...text];
    for (const atom of atoms) {
      const candidate = current + atom;
      if (measure.measureText(candidate).width > maxWidth && current) {
        lines.push(current.trimEnd());
        current = atom.trimStart();
      } else {
        current = candidate;
      }
      if (lines.length >= BUBBLE_LINES) break;
    }
    if (current && lines.length < BUBBLE_LINES) lines.push(current.trimEnd());

    const width = Math.ceil(Math.max(...lines.map((l) => measure.measureText(l).width))) + padX * 2;
    const height = lines.length * lineHeight + padY * 2 + TAIL_HEIGHT;

    const canvas = document.createElement('canvas');
    canvas.width = width * TEXTURE_SCALE;
    canvas.height = height * TEXTURE_SCALE;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(TEXTURE_SCALE, TEXTURE_SCALE);

    const bodyHeight = height - TAIL_HEIGHT;
    const r = 14;
    ctx.fillStyle = 'rgba(247, 243, 235, 0.95)';
    ctx.strokeStyle = 'rgba(55, 63, 66, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(width, 0, width, r, r);
    ctx.arcTo(width, bodyHeight, width - r, bodyHeight, r);
    // The tail, pointing down at the speaker's head.
    ctx.lineTo(width / 2 + 9, bodyHeight);
    ctx.lineTo(width / 2, height);
    ctx.lineTo(width / 2 - 9, bodyHeight);
    ctx.arcTo(0, bodyHeight, 0, bodyHeight - r, r);
    ctx.arcTo(0, 0, r, 0, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#373F42';
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], width / 2, padY + lineHeight * (i + 0.5));
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.userData.aspect = width / height;
    texture.userData.height = height;
    return this.remember(key, texture, 'b:', NameTags.BUBBLE_CACHE);
  }

  /** Grow the pool on demand. Sprites are never destroyed, only hidden. */
  private acquire(index: number, pool: Tag[] = this.pool): Tag {
    let tag = pool[index];
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
    pool[index] = tag;
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

    this.updateBubbles(targets, cameraPos);
  }

  /**
   * Speech bubbles, ranked and faded independently of the name tags.
   *
   * Deliberately a second pass over the same targets rather than a field on the name pass:
   * the two have different ranges and different budgets, so a distant player whose name is
   * not drawn can still be seen to be talking — which is the whole point of a bubble.
   */
  private updateBubbles(targets: readonly TagTarget[], cameraPos: THREE.Vector3): void {
    const speaking = targets
      .filter((t) => !!t.bubble)
      .map((t) => ({ t, d: t.position.distanceTo(cameraPos) }))
      .filter((e) => e.d < BUBBLE_FADE_END)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_BUBBLES);

    for (let i = 0; i < speaking.length; i++) {
      const { t, d } = speaking[i];
      const bubble = this.acquire(i, this.bubblePool);
      const text = t.bubble!;

      if (bubble.renderedName !== text) {
        const texture = this.bubbleTextureFor(text);
        bubble.material.map = texture;
        bubble.material.needsUpdate = true;
        bubble.renderedName = text;
        // Sized from the texture's own pixel height so a two-line bubble is twice as tall
        // rather than twice as squashed.
        const aspect = (texture.userData.aspect as number) || 3;
        const worldHeight = (((texture.userData.height as number) || 60) / 60) * 0.5;
        bubble.sprite.scale.set(worldHeight * aspect, worldHeight, 1);
      }

      // The tail sits at the bottom of the sprite, so the sprite's centre is half its own
      // height above the anchor point.
      bubble.sprite.position.set(
        t.position.x,
        t.position.y + BUBBLE_HEIGHT + bubble.sprite.scale.y / 2,
        t.position.z,
      );
      const fade = 1 - Math.max(0, Math.min(1, (d - BUBBLE_FADE_START) / (BUBBLE_FADE_END - BUBBLE_FADE_START)));
      bubble.material.opacity = fade;
      bubble.sprite.visible = fade > 0.02;
    }

    for (let i = speaking.length; i < this.bubblePool.length; i++) {
      if (this.bubblePool[i]?.sprite.visible) this.bubblePool[i].sprite.visible = false;
    }
  }

  dispose(): void {
    for (const tag of [...this.pool, ...this.bubblePool]) {
      tag.material.dispose();
      tag.sprite.removeFromParent();
    }
    this.pool.length = 0;
    this.bubblePool.length = 0;
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
  }
}
