/**
 * Emote glyphs.
 * =============
 *
 * Someone waves, and a small 👋 rises over their head and fades — so an emote is seen by
 * people who were not looking at the right figure at the right moment, and by everyone at
 * a distance where the gesture itself is a few pixels. Yours too: it is the confirmation
 * that everyone else saw it.
 *
 * A glyph is a camera-facing quad carrying the emoji drawn once into a canvas, laid over
 * the drawing without being outlined (see `fx/materials.ts`), and hidden by buildings like
 * anything else in the world. Eight textures, one per emote, made the first time each is
 * used; a small pool of quads, the oldest reused when a crowd emotes all at once.
 */

import * as THREE from 'three';
import type { Emote, PlayerId } from '@nagisa/shared';
import type { FxHost } from './index.js';
import { FX_OUTPUTS, fxMaterial } from './materials.js';

/** The same glyphs as the emote wheel (`ui/EmoteWheel.svelte`), which is what was chosen. */
const GLYPH: Record<Emote, string> = {
  wave: '👋',
  clap: '👏',
  bow: '🙇',
  heart: '❤️',
  laugh: '😄',
  question: '❓',
  music: '🎵',
  sparkle: '✨',
};

/** Seconds a glyph is up. */
const LIFE = 1.8;

/** Where it starts and how far it rises, metres above the feet. Clear of the name plate. */
const START_HEIGHT = 2.55;
const RISE = 0.7;

/** Glyph size, metres. */
const SIZE = 0.46;

/** Glyphs up at once. */
const POOL = 16;

const VERTEX = /* glsl */ `
uniform vec3 uCenter;
uniform float uSize;
out vec2 vUv;
void main() {
  vUv = uv;
  // Billboard: offset the corners in view space, so the glyph always faces the camera.
  vec4 mv = viewMatrix * vec4(uCenter, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
in vec2 vUv;
${FX_OUTPUTS}
void main() {
  vec4 texel = texture(uMap, vUv);
  float a = texel.a * uOpacity;
  if (a < 0.01) discard;
  gColor = vec4(texel.rgb, a);
  gInfo = vec4(0.0);
}
`;

interface Glyph {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  owner: PlayerId;
  age: number;
  active: boolean;
  /** Where the owner was last seen, so a glyph finishes its rise if they leave. */
  readonly anchor: THREE.Vector3;
}

export class EmoteFloats {
  private readonly glyphs: Glyph[] = [];
  private readonly quad = new THREE.PlaneGeometry(1, 1);
  private readonly textures = new Map<Emote, THREE.CanvasTexture>();

  constructor(
    private readonly host: FxHost,
    group: THREE.Group,
  ) {
    for (let i = 0; i < POOL; i++) {
      const material = fxMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        blend: 'over',
        uniforms: {
          uCenter: { value: new THREE.Vector3() },
          uSize: { value: SIZE },
          uMap: { value: null },
          uOpacity: { value: 0 },
        },
      });
      const mesh = new THREE.Mesh(this.quad, material);
      // The quad is placed in the shader; its own transform is the origin.
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 6;
      group.add(mesh);
      this.glyphs.push({ mesh, material, owner: '', age: 0, active: false, anchor: new THREE.Vector3() });
    }
  }

  /** Raise a glyph over someone's head. */
  show(id: PlayerId, emote: Emote): void {
    const texture = this.textureFor(emote);
    if (!texture) return;
    const position = this.host.playerPosition(id);
    if (!position) return;
    // A second emote from the same person replaces the first rather than stacking.
    const glyph =
      this.glyphs.find((g) => g.active && g.owner === id) ??
      this.glyphs.find((g) => !g.active) ??
      this.glyphs.reduce((a, b) => (a.age > b.age ? a : b));
    glyph.active = true;
    glyph.owner = id;
    glyph.age = 0;
    glyph.anchor.copy(position);
    glyph.material.uniforms.uMap.value = texture;
  }

  update(dt: number): void {
    for (const glyph of this.glyphs) {
      if (!glyph.active) continue;
      glyph.age += dt;
      if (glyph.age >= LIFE) {
        glyph.active = false;
        glyph.mesh.visible = false;
        continue;
      }
      const position = this.host.playerPosition(glyph.owner);
      if (position) glyph.anchor.copy(position);
      const t = glyph.age / LIFE;
      // Rising and slowing; in quickly, out over the last third.
      const rise = RISE * (1 - (1 - t) * (1 - t));
      const opacity = Math.min(1, glyph.age / 0.2) * Math.min(1, (1 - t) / 0.35);
      glyph.material.uniforms.uCenter.value.set(glyph.anchor.x, glyph.anchor.y + START_HEIGHT + rise, glyph.anchor.z);
      glyph.material.uniforms.uOpacity.value = opacity;
      glyph.mesh.visible = true;
    }
  }

  dispose(): void {
    for (const glyph of this.glyphs) {
      glyph.material.dispose();
      glyph.mesh.removeFromParent();
    }
    this.quad.dispose();
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
  }

  /** The emoji, drawn once at 128 px into a canvas. Null where there is no 2D canvas. */
  private textureFor(emote: Emote): THREE.CanvasTexture | null {
    const known = this.textures.get(emote);
    if (known) return known;
    const glyph = GLYPH[emote];
    if (!glyph) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.font = '96px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, 64, 70);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    this.textures.set(emote, texture);
    return texture;
  }
}
