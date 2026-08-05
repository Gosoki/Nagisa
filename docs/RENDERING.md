# Rendering — the ink pipeline

Nagisa is drawn, not lit. Every frame is a flat fill, a named shadow tone, a pen contour and
a sheet of paper grain over the top. This document is how that is put together, and — more
usefully — the small number of things that will silently ruin it.

The look follows [messenger.abeto.co](https://messenger.abeto.co/), which is the reference
this whole product is aligned to. The *technique* below (a multiple-render-target geometry
buffer, a cross-shaped edge detector over depth/normal/material-id, a distance fade) is a
well-established stylised-rendering approach rather than anything proprietary; the
implementation is ours, and no asset from the reference is used.

---

## 1. The frame

```
   ┌─ geometry pass ─────────────────────────────────────────────────┐
   │  scene → WebGLRenderTarget { count: 2, type: HalfFloat }        │
   │                                                                 │
   │  target 0   rgb  shaded colour                                  │
   │             a    material id, quantised to 16 steps             │
   │  target 1   r    linear view depth / uDepthScale                │
   │             gb   view normal, spheremap-encoded                 │
   │             a    outline participation mask                     │
   └────────────────────────┬────────────────────────────────────────┘
                            ↓
   ┌─ composite (one fullscreen quad) ───────────────────────────────┐
   │  5-tap cross → depth / normal / id discontinuities              │
   │  → ink colour, faded with distance                              │
   │  → linear → sRGB                                                │
   │  → warm/cool grade, contrast                                    │
   │  → paper grain, vignette                                        │
   └─────────────────────────────────────────────────────────────────┘
```

There is no `EffectComposer` chain. The ink pass *is* the post chain, and stacking three.js
passes behind it would cost a full-resolution read/write each for a look that is already
finished.

Files:

| File | What lives there |
|---|---|
| `engine/ink/glsl.ts` | Shared chunks: normal codec, depth codec, paper/hatch noise, `fit` |
| `engine/ink/ink-material.ts` | The one material every solid surface uses, plus the shared lighting uniforms |
| `engine/ink/ink-pass.ts` | The MRT target and the composite shader |
| `engine/renderer.ts` | Owns the context, the camera and the frame loop |
| `world/materials.ts` | Named, cached materials — the palette applied |

WebGL2 is required for MRT. If the context comes back WebGL1 the pipeline falls back to
rendering straight to the canvas: flat shading, no contours, still playable. `hasInk` says
which one is running.

---

## 2. Why not `MeshToonMaterial`

Three's toon material gives a cel ramp and nothing else. It cannot write a second buffer, so
there is nowhere to put the view normal, the linear depth and the outline mask a
screen-space contour detector reads.

Without those, the only available outline technique is the **inverted hull** — a second,
back-facing, fattened copy of every mesh. That doubles the scene's triangle count, cannot
draw the *interior* lines that make a drawing read as a drawing, and produces the pinched,
uneven contours that give inverted-hull games away.

The cost of the custom material is that three's shadow machinery has to be wired by hand.
See §6.

---

## 3. Shading

One key light, one sky fill, one bounce from the sea, and a shadow map. The terminator is
deliberately hard — a couple of degrees wide, not a gradient. What keeps the dark side
readable is the fill and the bounce, not a soft falloff.

**Shadow colour is authored, not derived.** Every material carries a `*Shadow` token beside
its base. Real shade in a painting is cooler and less saturated than the light beside it,
and converges toward the ambient rather than toward black — a wall in shadow under a blue
sky is a *blue-grey* wall, not a dark wall. `deriveShadow()` does the same thing
automatically for materials that do not author one: rotate the hue toward the cool end, cut
saturation, drop lightness, then pull in a little sky fill.

Shadow tones are **shallow** — around 70–80% of the base's luminance, not 50%. The world is
high-key: light masses with dark line work, and the contour pass is what draws the form.
Deep shadow tones fight it. Every wall facing away from the sun turns into a black slab, the
pen lines vanish inside it, and the result reads as an unlit 3D model rather than as a
drawing. **If a surface looks flat, the fix is a material id — a line — never a darker
shadow.**

On top of that: pen hatching on the shadow side (two sets at different densities and phases,
so it reads as a hand building up tone rather than as a screen door), a thin rim where the
surface turns away from the eye, and paper grain over everything.

---

## 4. Material ids, and why they matter more than they look

Each material carries a `matId`, quantised into 16 buckets and written into the colour
buffer's alpha. The composite draws a line wherever neighbouring pixels disagree.

This is what catches edges that have **no geometric discontinuity at all**: a painted band
on the lighthouse, a roof meeting the wall it sits flush against, a jacket over a shirt.
Depth and normal detection cannot see any of those. Without the id test, buildings lose
exactly the lines a person would draw first.

The ids are grouped by *what someone drawing this would treat as one object*: all the timber
of a building shares an id, its roof has another, its plaster a third. A character's
clothing is deliberately split across `clothingA` (jacket, sleeves) and `clothingB`
(trousers, collar) — that single decision is what makes a jacket read as a garment worn over
something rather than as a differently-coloured section of the same solid.

---

## 5. Four bugs this pipeline invites

All four were hit during the build. All four look like something else, which is why they are
written down. `tools/shot.mjs --inkdebug all` puts each detector's contribution in its own
colour channel (depth red, normal green, id blue) and answers "which test drew this line" in
one render — the question that is otherwise unanswerable, because all three produce
identical ink.

### The depth encoding

The info buffer is half-float, whose precision is **relative**: an ULP near 1.0 is 2⁻¹¹ ≈
0.0005, while near 0.05 it is 2⁻¹⁶ ≈ 0.000015 — thirty times finer.

An early version stored `1 − dist/far` with a 3.6 km far plane. That parks every value in
the scene up near 1.0 and quantises depth into 1.8 m steps. The detector faithfully drew a
line at every step boundary and **the mountain rendered as a contour map**.

Store `dist / uDepthScale` with a few-hundred-metre reference range instead — not inverted,
and not scaled by the camera's far plane. Nearby geometry then lives in the fine end of the
float, where a 20 m surface quantises at about 6 mm.

### The quantisation noise floor

Even with the encoding fixed, precision still degrades with distance: about 1.5 cm at 30 m
and 15 cm at 300 m. A threshold in absolute metres sits below the quantisation almost
everywhere, so the detector fires on rounding error across every flat surface.

That does **not** look like noise. It looks like every building in the scene being *filled*
with solid ink — which reads as "the lighting is broken" and sends you tuning the palette
for an hour.

The detector therefore subtracts an estimate of the quantisation (`uDepthNoise · depth`)
before thresholding, and then divides by view distance so the threshold is scale-invariant.
A genuinely flat surface scores exactly zero.

### The depth detector will draw the terrain grid

Even correctly encoded and noise-floored, a threshold tuned by what it should *draw* is
wrong. The terrain is a 1.6 m grid, so its facet-to-facet depth steps land around 0.002 in
relative units at any distance — invisible to the eye, and far above the noise floor. A
detector tuned tighter than that draws every one of them, and the hillside comes out ruled
with horizontal lines at constant depth.

Thresholds are therefore set by what has to be **rejected**. 0.0035 sits above the grid;
a real silhouette (a metre of gap at a hundred metres, or half a metre at ten) clears it
comfortably. The interior detail the depth test gives up this way — tile courses, plank
lines — is picked up by the normal and material-id tests, which is what they are for.

The same applies to the grazing correction: a surface seen edge-on fools *both* geometric
detectors, because one pixel spans metres of it. Both thresholds are raised as the surface
turns away from the camera, and both corrections cost nothing on the surfaces facing you,
where all the lines that matter are.

### Terrain must be smooth-shaded

`flatShading` on the terrain gives every one of its 320 000 triangles its own normal, which
the contour pass dutifully detects — a pen line along every triangle edge, and the mountain
is a topographic map again. The worker computes exact analytic normals per vertex, so smooth
shading there is both correct and free.

Flat shading is right for everything else. Faceted low-poly surfaces are what make the world
read as crafted.

---

## 6. Wiring three's shadows into a custom material

Three renders shadows for materials it knows about. Getting them for a `ShaderMaterial`
takes three things, and missing any one of them fails quietly:

1. **Include order.** `<shadowmask_pars_fragment>` calls `getShadow()` from
   `<shadowmap_pars_fragment>`, and both read `receiveShadow` and the
   `DirectionalLightShadow` struct declared in `<lights_pars_begin>`. All three, in that
   order, plus `<shadowmap_pars_vertex>` and `<shadowmap_vertex>`.
2. **`lights: true`, and `UniformsLib.lights` merged in.** Nothing in the shader reads a
   light uniform directly, but three only wires the shadow map and shadow matrices into a
   ShaderMaterial's uniforms when that flag is on — and it writes into those slots
   unconditionally, so they have to exist.
3. **`customDepthMaterial` on every mesh.** Three cannot render an arbitrary shader into a
   shadow map. One shared `MeshDepthMaterial` with `RGBADepthPacking`, assigned in
   `island.ts` and in the character rig, is what makes the whole island cast shadows.

The one real light in the scene is a `DirectionalLight` that exists **only** to produce the
shadow map. Its colour and intensity are never read. Everything else is driven from
`inkLighting`, a single object of shared uniforms the sky director writes once per frame —
one write updates every material on the island.

---

## 7. Colour space

Everything up to the composite is linear: the geometry buffer is a linear half-float target,
and `THREE.Color` converts authored sRGB hex into linear working space on upload.

The composite converts to display space **before** the grade, because contrast pivoted on
mid-grey and a warm/cool split only behave the way an eye expects there. It also has to do
the conversion three would otherwise apply for a built-in material, since it writes straight
to the canvas. `renderer.toneMapping` is therefore `NoToneMapping` — leaving three's own
curve on would apply it twice.

---

## 8. Sea and sky

Both write the MRT like everything else, and both write **0** into the outline mask.

The sea draws its own lines. Left to the contour pass, water would be traced as one hard
cut-out edge against the shore, which reads as a sticker. What a person would put down
instead is a foam line that thickens in the shallows and a scatter of short horizontal wave
strokes — so the shader draws those itself, at the contours of the baked bathymetry.

The sky's clouds are the same idea: a noise field on the view direction, hard-thresholded
into a paper-cut shape, with the ink line drawn exactly at the threshold. Doing it in the
dome shader means no sorting, no overdraw, no transparency and no cloud clipping through the
lighthouse. The projection divides by `d.y`, so the cloud deck has to be held well clear of
the horizon or a rounded shape overhead becomes a vertical smear reaching down to the sea.

One thing to know about the sea geometry: it is a polar disc, and its winding must be
counter-clockwise **seen from above**. Getting that backwards does not produce a dark sea or
a flipped sea — it back-face culls every triangle, the water vanishes completely, and what
you see instead is the seabed and the underside of the sky dome.

---

## 9. Reviewing it

The failure modes of a stylised renderer are pictures. A shader that compiles, a material
that batches and a contour pass that runs at 60 fps can still produce a frame with the
outlines inverted, the shadow tone reading as mud, or the ocean drawn over the island —
none of which a type checker or a unit test can see.

```
node tools/shot.mjs                      # twelve viewpoints → PNG
node tools/shot.mjs plaza --time 0.78    # one viewpoint at dusk
node tools/shot.mjs quay --ink 0         # contours off, to compare
node tools/shot.mjs quay --inkdebug all  # detector contributions: depth/normal/id → r/g/b
node tools/shot.mjs quay --debug ocean   # recolour the sea, to answer "is it there at all"
node tools/pixel-probe.mjs quay          # live material uniforms
node tools/app-smoke.mjs                 # the whole stack, two players, end to end
```

`apps/client/probe.html` is the page they drive: the real island, the real materials and the
real ink pass, with no interface, no netcode and no input. It uses the *production* modules
deliberately — a probe that renders its own approximation of the island tells you nothing
about the island.

The tools run Chromium on SwiftShader, so they are a **correctness** check. The draw-call
and triangle counts they print are real; the frame rate is not.

---

## 10. Budgets

Measured at 1280 × 760, `high` tier, from the twelve probe viewpoints:

| | Range |
|---|---|
| Draw calls | 386 (a single figure) – 1 365 (the harbour) |
| Draw calls, `gameplay` framing | 879 |
| Triangles | 1.43 M – 1.51 M |
| Shader programs | 10 |
| Landmark geometry | ~62 000 triangles across 107 landmarks |
| Scatter | 18 567 instances, 4 draw calls |
| Terrain mesh build | ~1.1 s on SwiftShader, ~150 ms on real hardware |

The draw-call count is dominated by the props, and the material cache is what keeps it
there: every prop asks `materials.ts` for a shared instance by key, so a machiya built from
ninety primitives across five materials arrives as five draw calls. A prop file that calls
`new THREE.ShaderMaterial` directly would break batching for the entire island — which is
why no file in `props/` does, and why they take their materials as arguments instead.
