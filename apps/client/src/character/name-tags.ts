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
 * ### Why not `THREE.Sprite`
 *
 * They were, and none of them was ever drawn. The world is rendered into a two-target
 * geometry buffer (see `docs/RENDERING.md`), and a built-in material's shader declares only
 * the first output; WebGL refuses a draw that leaves an active draw buffer without one
 * ("Active draw buffers with missing fragment shader outputs") and skips it. So every plate
 * and every speech bubble failed silently, every frame. They are camera-facing quads with a
 * shader that writes both targets the way the effects layer does (`fx/materials.ts`): the
 * plate is laid over the drawing, and the contour pass never sees it. A second, invisible
 * draw under each one clears the outline mask where the plate is, so the pen lines of the
 * roofs behind a name are not drawn through it.
 *
 * Textures are cached by content (name, accent, title), so a hundred players called
 * "Visitor" share one texture.
 */

import * as THREE from 'three';
import { FX_OUTPUTS, fxMaterial } from '../fx/materials.js';

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

/** World height of a one-line plate, metres. A plate with a title line grows *upward*. */
const PLATE_HEIGHT = 0.42;

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
  /**
   * The badge they wear, already in words — its icon and name, e.g. "🎣 Angler" — drawn
   * small under the name. The caller localises it; the plate only draws it.
   */
  title?: string | null;
}

/**
 * A label quad, always facing the camera. Sized by the mesh's own x/y scale, in metres,
 * exactly as a `THREE.Sprite` is — see the header for why it is not one.
 */
const LABEL_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  gl_Position = projectionMatrix * mv;
}
`;

const LABEL_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
in vec2 vUv;
${FX_OUTPUTS}
void main() {
  vec4 texel = texture(uMap, vUv);
  float a = texel.a * uOpacity;
  if (a < 0.004) discard;
  gColor = vec4(texel.rgb, a);
  gInfo = vec4(0.0);
}
`;

/** The same quad again, drawing nothing but clearing the outline mask under the label. */
const LABEL_UNLINE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
in vec2 vUv;
${FX_OUTPUTS}
void main() {
  float a = texture(uMap, vUv).a * uOpacity;
  if (a < 0.004) discard;
  gColor = vec4(0.0);
  gInfo = vec4(0.0, 0.0, 0.0, a);
}
`;

/** One pooled label. */
interface Tag {
  sprite: THREE.Mesh;
  material: THREE.ShaderMaterial;
  /** Name currently rendered on this sprite's texture, so we only re-render on change. */
  renderedName: string | null;
  renderedHighlight: boolean;
  renderedTitle: string | null;
}

export class NameTags {
  readonly group = new THREE.Group();

  private readonly pool: Tag[] = [];
  private readonly bubblePool: Tag[] = [];
  /** The one quad every label is drawn on. */
  private readonly quad = new THREE.PlaneGeometry(1, 1);
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
   * Render a texture for a name, and the title under it if they wear one.
   *
   * Drawn as light text on a soft dark plate rather than the reverse: the island's sky
   * and sand are both pale, and dark-on-light labels vanish against them.
   *
   * The title is a second, smaller and fainter line on the same plate rather than a plate
   * of its own: it belongs to the name, and a second sprite would be a second thing to rank,
   * fade and keep in step. Keyed into the cache with the name, so wearing a different badge
   * renders a new plate — and the old one ages out of the LRU like any other.
   */
  private textureFor(name: string, highlight: boolean, title: string | null): THREE.CanvasTexture {
    const key = `${highlight ? 'h:' : 'n:'}${name}${title ? `\u0000${title}` : ''}`;
    const cached = this.textures.get(key);
    if (cached) return cached;

    const fontSize = 34;
    const titleSize = 22;
    const titleGap = 4;
    const padX = 18;
    const padY = 10;
    const font = `500 ${fontSize}px -apple-system, "Segoe UI", "Hiragino Sans", sans-serif`;
    const titleFont = `500 ${titleSize}px -apple-system, "Segoe UI", "Hiragino Sans", "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;

    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) throw new Error('2D canvas context unavailable');
    measure.font = font;
    let textWidth = measure.measureText(name).width;
    if (title) {
      measure.font = titleFont;
      textWidth = Math.max(textWidth, measure.measureText(title).width);
    }
    const width = Math.ceil(textWidth) + padX * 2;
    const height = fontSize + padY * 2 + (title ? titleSize + titleGap : 0);

    const canvas = document.createElement('canvas');
    canvas.width = width * TEXTURE_SCALE;
    canvas.height = height * TEXTURE_SCALE;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(TEXTURE_SCALE, TEXTURE_SCALE);

    // Plate: warm near-black at low opacity, fully rounded — capsule for one line, and the
    // same radius on the taller two-line plate so the two read as the same object.
    ctx.fillStyle = highlight ? 'rgba(196, 80, 58, 0.88)' : 'rgba(38, 34, 30, 0.62)';
    const r = (fontSize + padY * 2) / 2;
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
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, width / 2, padY + fontSize / 2 + 1);
    if (title) {
      ctx.fillStyle = 'rgba(246, 242, 234, 0.72)';
      ctx.font = titleFont;
      ctx.fillText(title, width / 2, padY + fontSize + titleGap + titleSize / 2);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    // Store the plate's shape so `update` can size the sprite without re-measuring.
    texture.userData.aspect = width / height;
    texture.userData.lines = height / (fontSize + padY * 2);
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

    // Depth-tested so a building hides a name behind it; no depth writes, so overlapping
    // tags blend rather than z-fight.
    const material = fxMaterial({
      vertexShader: LABEL_VERTEX,
      fragmentShader: LABEL_FRAGMENT,
      blend: 'over',
      uniforms: { uMap: { value: null }, uOpacity: { value: 0 } },
    });
    const sprite = new THREE.Mesh(this.quad, material);
    sprite.visible = false;
    sprite.renderOrder = 5;
    // Same uniforms, so it always covers exactly what the label does; a child, so it shares
    // the label's transform and visibility.
    const unline = new THREE.Mesh(
      this.quad,
      fxMaterial({ vertexShader: LABEL_VERTEX, fragmentShader: LABEL_UNLINE_FRAGMENT, blend: 'unline', uniforms: material.uniforms }),
    );
    unline.renderOrder = 4;
    sprite.add(unline);
    this.group.add(sprite);

    tag = { sprite, material, renderedName: null, renderedHighlight: false, renderedTitle: null };
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

    // Rank by distance, keeping only those inside the fade window. A target with no name is
    // there for its bubble alone — yours, which gets no plate — and must not draw an empty one.
    const ranked = targets
      .map((t) => ({ t, d: t.position.distanceTo(cameraPos) }))
      .filter((e) => e.d < FADE_END && e.t.name !== '')
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_TAGS);

    for (let i = 0; i < ranked.length; i++) {
      const { t, d } = ranked[i];
      const tag = this.acquire(i);

      // Only touch the texture when the label's content actually changed — creating a
      // CanvasTexture per frame would be a memory leak with a nice API.
      const highlight = t.highlight ?? false;
      const title = t.title ?? null;
      if (tag.renderedName !== t.name || tag.renderedHighlight !== highlight || tag.renderedTitle !== title) {
        const texture = this.textureFor(t.name, highlight, title);
        tag.material.uniforms.uMap.value = texture;
        tag.renderedName = t.name;
        tag.renderedHighlight = highlight;
        tag.renderedTitle = title;

        // Sprite scale is in world units; 0.42 m tall reads as a label rather than a
        // billboard at character scale. A titled plate is proportionally taller.
        const aspect = (texture.userData.aspect as number) || 3;
        const plateHeight = PLATE_HEIGHT * ((texture.userData.lines as number) || 1);
        tag.sprite.scale.set(plateHeight * aspect, plateHeight, 1);
      }

      // The plate's bottom edge stays where a one-line plate's is, just clear of the head,
      // and a title line extends it upward toward the bubble.
      tag.sprite.position.set(t.position.x, t.position.y + TAG_HEIGHT + (tag.sprite.scale.y - PLATE_HEIGHT) / 2, t.position.z);
      // Fade rather than pop. Squared falloff so tags thin out gently as a crowd recedes.
      const fade = 1 - Math.max(0, Math.min(1, (d - FADE_START) / (FADE_END - FADE_START)));
      tag.material.uniforms.uOpacity.value = fade * fade;
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
        bubble.material.uniforms.uMap.value = texture;
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
      bubble.material.uniforms.uOpacity.value = fade;
      bubble.sprite.visible = fade > 0.02;
    }

    for (let i = speaking.length; i < this.bubblePool.length; i++) {
      if (this.bubblePool[i]?.sprite.visible) this.bubblePool[i].sprite.visible = false;
    }
  }

  dispose(): void {
    for (const tag of [...this.pool, ...this.bubblePool]) {
      tag.material.dispose();
      for (const child of tag.sprite.children) ((child as THREE.Mesh).material as THREE.Material).dispose();
      tag.sprite.removeFromParent();
    }
    this.pool.length = 0;
    this.bubblePool.length = 0;
    this.quad.dispose();
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
  }
}
