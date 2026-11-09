/* ============================================================================
   globe.js — Boring Media hero globe, v3.0 (WebGL, three.js r147)

   A realistic, multi-colour Earth on the logo-blue page — a navy dot-matrix
   ocean, raised land plates coloured from a real map, a cream bevel, amber
   city lights, a thin blue atmosphere, logo-blue-white rings and arcs.
   v3.0 vs v2.1.2:
   · Everything the page used to compute on load is baked offline
     (_sources/bake/: bake.html runs the v2.1.2 pipeline once in Chrome, so
     the plates, coast field and every light are bit-identical): no runtime
     image readback, no chamfer, no light sampling, no cities-10m.json. The
     globe now downloads three small textures + one light list, and a Worker
     fetches, decodes (createImageBitmap) and parses them and builds the
     sphere mesh, while the main thread compiles the shader programs.
   · Realism pass, each A/B-cropped against v2.1.2 and kept because it read
     better (CFG "realism"):
     terrain hillshade (Rockies, Andes, Alps, Himalaya, East Africa, the
     Greenland dome), a graded colour map (richer forests, warmer deserts,
     olive tundra, blue-white ice, lakes that read as water), a continental
     shelf / shallow-bank tint from Blue Marble's real bathymetry, a warm sun
     glint on the ocean, city lights weighted toward the night side, and a
     thin blue atmosphere brightest on the sunlit limb. Rejected: a dusk band
     (read as a stripe) and procedural clouds (read as milky mottling).
   · Point sprites never draw below one CSS pixel and the bloom chain runs
     at CSS resolution, so lights and glow look the same at 1×, 1.5× and on
     the posters (a 1.5× screen used to show 44 % of the 1× light).
   · Software-GL / weak-GPU guard: a software renderer, a failed
     failIfMajorPerformanceCaveat context or a first-60-frames average under
     40 fps → onFail('perf') and the module destroys itself (the page keeps
     its poster). The build never runs on a software renderer.
   · Arc endpoints are compiled in (METROS: Natural Earth metros, US weighted);
     opts.cities still overrides them.
   · Posters: BMGlobe.POSTER describes the static renders the page uses as
     placeholder/fallback (globe-assets/poster-*.webp, see CONTRACT.md).

   What it draws (a stylised render, not a photo Earth):
   · One sphere ShaderMaterial: an equal-arc dot-matrix skin (round(N·cos lat)
     cells per row, fwidth anti-aliasing, sub-pixel cells fade to their mean),
     raised plates from the signed coast-distance field (vertex displacement
     with a ~1° ramp that settles toward the limb), a bevel band lit cream on
     the key side and sand-brown away from it, a slab shadow on the ocean,
     terrain hillshade from the topology map, land colour from the graded
     map, a continental shelf / shallow-bank tint, a warm ocean glint, a thin
     blue atmosphere on the sunlit limb.
   · City lights as discrete points from NASA Black Marble (lights, larger hot
     cores, and a dim city-seeded layer where the night map is weak), amber →
     warm white; UnrealBloom fuses the clusters into glowing masses.
   · Great-circle arcs between real metros (screen-space ribbons, one bead
     travels each, amber endpoint flashes), six hairline rings with comet runs
     and satellites (two dashed), drifting specks, a soft blue halo.

   Assets (globe-assets/; open licences — keep these credits). All images are
   stored SOUTH-UP (row 0 = south pole) so they upload with flipY = false:
   · earth-coast-2048.webp — lossless greyscale: the signed coast distance
     (Natural Earth 50 m land, public domain). All tiers.
   · earth-fields-2048.webp (desktop) / -1024.webp (mid/phone) — lossless:
     R elevation (three-globe topology map, NASA SRTM-derived, lightly
     smoothed), G ocean shallowness (NASA Blue Marble bathymetric shading,
     public domain), B city-light wash (NASA Black Marble, public domain).
   · earth-color-2048.webp (desktop) / -1024.webp (mid/phone) — the plate
     colour: 45 % NASA Blue Marble + 55 % three-globe earth-day (MIT repo,
     NASA-derived), graded offline, the ocean filled with the nearest land.
   · lights-4096.bin / lights-2048.bin — the baked light lists from NASA Black
     Marble 2016 (public domain): see the format note at DATA_JOB.
   · vendor/three.min.js — three.js r147 (MIT, vendor/LICENSE) as a custom
     tree-shaken build: the core subset this module uses + EffectComposer,
     RenderPass, ShaderPass, UnrealBloomPass, CopyShader and
     LuminosityHighPassShader, with ShaderChunk trimmed to the chunks this
     scene compiles — 336 KB instead of 594 KB + 23 KB of pass files,
     rendering pixel-identically (_sources/three-build/). With a stock
     three.min.js instead, this module loads the six pass files from
     assetBase + 'vendor/' (keep them there in that case).
   The offline sources, the bake and the licences are documented with the
   source files (_sources/README.md in the build folder; not shipped).

   API:  window.BMGlobe.mount(container, opts) → handle
     opts: { assetBase, reducedMotion, width, loop: 'external'|'self',
             geometry: {W,H,R,cx,cy}, cities,
             onReady(), onFail(reason), onLost(), onRestored() }
       onFail(reason): reason is the string 'perf' for the software-GL /
       weak-GPU guard, otherwise an Error (a file failed, three.js missing a
       pass, a throw while building). The module has destroyed itself by then.
     handle: { pause(), resume(), destroy(), setPointer(nx, ny),
               setQuality('high'|'low'), setGeometry(g), render(t, dt),
               setReducedMotion(v), stats(), ready, readyPromise }
     window.BMGlobe = { mount, CFG, TIERS, POSTER, version }
   The module announces itself with a 'bmglobe-ready' event on window once
   window.BMGlobe exists, so a host can mount whatever the script order is.
   It marks 'bmglobe:mount' / 'bmglobe:ready' and measures 'bmglobe:build'
   (User Timing — Lighthouse lists them), and logs one console.debug line
   ('[orbit] …') when it is ready; nothing else in normal operation.
   Tiers by viewport width (< 768 phone, < 1024 mid, else desktop): the light
   list, the fields and colour maps, mesh density and displacement ramp
   follow the tier at mount; point shares, arcs alive and the pixel-ratio cap (1.25 below
   desktop, 1.5 desktop) re-tier on every setGeometry.
   With loop:'external' the host's single rAF loop calls handle.render(t, dt);
   otherwise the module runs its own loop and pauses when hidden/offscreen.
   ========================================================================== */
(function () {
'use strict';

let T = null;   // window.THREE, read at mount time
const PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hex = h => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
/* a task boundary, so input and frames get in between the build's slices: scheduler.yield() where it exists (no 4 ms clamp
   once timeouts nest), else a zero timeout */
const nextTick = () => (window.scheduler && typeof window.scheduler.yield === 'function') ? window.scheduler.yield() : new Promise(r => setTimeout(r, 0));
const mark = n => { try { performance.mark(n); } catch (e) {} };

/* ---------------------------------------------------------------- knobs */
const CFG = {
  D: 5.0,                      // camera distance in radii (perspective amount)
  tiltX: 0.30, tiltZ: -0.10,   // axis tipped toward the camera / leaning left
  lon0: -35,                   // longitude facing the camera at t = 0 (Atlantic)
  omega: TAU / 80,             // spin: one revolution per 80 s
  parallax: 0.07,              // pointer parallax, radians
  plate: 0.012,                // plate height, in radii
  ramp: 6, rampPhone: 7.5,     // plate displacement ramp, ± texels of the 2048 field (≈ ±1°): wider than the mesh spacing → no shards
  bump: 1.5, edge: 0.62, glint: 0.55, topo: 0.0045, sheen: 0.22, wash: 0.35,   // bevel normal, bevel band, specular on lit bevels, relief, key-side ocean sheen, amber wash under clusters
  grey: 0.04, greyLo: 0.55, greyLift: 1.0,    // the key-lit tops take only a trace of sun-wash (v2.1.2: 0.15 / 1.18 turned the lit slabs grey); the luma knee keeps the body under the bloom threshold
  halo: 0.40, keyRim: 0.42,    // outer halo alpha (soft blue, leaning to the lit limb), pale rim toward the key light
  lift: 1.9, desat: 0.10,      // plate colour: luma lift and the mix toward grey (the graded map carries the restraint now; v2.1.2: 0.16)
  orbit: { ring: 0xbfe3f5, arc: 0xc9e8f8, arcHot: 0xffffff, ringAlpha: 0.62, flash: [1.0, 0.70, 0.30] },   // logo-blue-white rings/arcs; warm amber endpoint flashes (the city-light amber)
  /* realism (v3). Each was A/B-cropped against v2.1.2 and kept because it read better; 0 turns it off.
     Rejected in the A/B and removed: a warm dusk band at the terminator (read as an orange stripe across the disc) and
     procedural clouds at alpha ≤ 0.12 (read as milky mottling, not weather) */
  shelf: 1.3, shallow: 1.5,    // continental-shelf teal lift on the ocean dots / tropical shallow-bank turquoise (Bahamas, Caribbean, Red Sea, Sunda, Barrier Reef); v3.0's 0.9 / 1.0 only read when zoomed
  glintO: 0.5, glintPow: 40,   // warm sun glint on the ocean (replaces v2.1.2's blue sheen), lobe sharpness
  glintDir: 0.5,               // how far the glint's light is swung from the key light toward the camera. 0 = the key's true reflection, which lands on North America in the hero framing: it never read as a glint there and only lifted the dots off the US coast (taking the coast's contrast); 0.5 puts a soft glint on the open Atlantic
  topoGain: 1,                 // relief multiplier on top of topo (feeds the bevel normal)
  hill: 4.0, hillTilt: 0.02,   // terrain hillshade after the knee: gain, and how far the elevation gradient tilts the relief normal
  hillArid: 2.5,               // the hillshade gain on arid land (sand-coloured plates, from the colour map): the Sahara and Arabia read smooth, not crumpled (gain 4 mottled them)
  edgeLit: 0.5,                // extra light on the sunlit (cream) side of the plate bevel, × its brightest part: brings back the approved cream crest on lit coasts (0 = v3.0)
  dayNight: 0.85, night: 1.15, // lights × mix(dayNight, night, darkness): × 0.85 on the key-lit side, × 1.15 away from it (0.72 cost the US cluster its punch in the hero)
  atmo: 1,                     // 1 = a thin blue limb brightest on the key-lit side + a faint rim side (physically plausible); 0 = v2.1.2's crescent on the rim side
  limb: 1, limbPow: 4.5,       // that lit limb's strength and falloff exponent (higher = thinner). The CTA horizon poster shows the limb at 2.3× the hero's size, so it renders a fainter, thinner one (posters.py)
  /* point-sprite scale per layer: gl_PointSize = aSize · k · pr · (D−1) · R/259 ÷ depth. Lights and cores at .25–.40 are one device
     pixel (plus bloom). Every sprite is born at its final scale. */
  spriteK: { lights: 0.25, cores: 0.40, city: 0.25, specks: 1, sats: 1, flash: 1 },
  minPx: 1,                    // smallest point sprite in CSS px (× pixel ratio): most lights compute below a pixel, so without this they shrink — and dim — as the pixel ratio grows (a 1.5× screen showed 44 % of the 1× light)
  cellPx: 4.1, dotR: 0.25, dotsMax: 480,   // dot-matrix cell pitch in CSS px, dot radius in cells, cap on cells around the equator
  oceanDot: 0.5, landDot: 1.0, coast: 0.30,
  lightLimb: [0.08, 0.72],     // point-sprite fade toward the limb (smoothstep over n·v): no stacked white thread on the silhouette
  bloom: { strength: 1.05, radius: 0.60, threshold: 0.52, res: 1 },   // the amber lights, the rim and the ring comets bloom; the lifted land (knee 0.38, max ~0.44) stays under the high pass. res: the bloom chain runs at CSS px × res whatever the pixel ratio, so the glow has the same size on a 1×, 1.5× or poster render (and costs less on high-DPR screens)
  arcs: { max: 20, alive: 15, alivePhone: 7, minDeg: 18, maxDeg: 100, minLean: 0.45, dur: [9.0, 14.0], width: 0.7, alpha: 0.5 },   // 15 alive keeps ≥ 8 fully drawn on desktop at every moment (12 dipped to 5 once the seeded set expired); minLean rejects pairs whose great circle lies near the view line (they project as straight chords)
  specks: 2000, specksPhone: 700,
  intro: 1.2,                  // seconds over which the arcs, their endpoint flashes and the specks fade in from the first live frame: the poster has none of them, so nothing pops in during the page's crossfade (0 = from the start)
  fpsMin: 40,                  // the first 60 frames after the crossfade must average at least this, else onFail('perf')
  assets: {
    coast: 'earth-coast-2048.webp',
    fields: { desktop: 'earth-fields-2048.webp', mid: 'earth-fields-1024.webp', phone: 'earth-fields-1024.webp' },
    color: { desktop: 'earth-color-2048.webp', mid: 'earth-color-1024.webp', phone: 'earth-color-1024.webp' },
    lights: { desktop: 'lights-4096.bin', mid: 'lights-2048.bin', phone: 'lights-2048.bin' }
  },
  rings: [ // r in radii; rx = tilt from edge-on, rz = ellipse orientation (deg); dash = dash count or 0
    { r: 1.72, rx: 22, ry: 0, rz: -8, base: 0.75, comet: 2.1, dash: 0, sats: [[0.0, 0.11, 5.0], [2.4, 0.11, 3.2]] },
    { r: 1.46, rx: 34, ry: 18, rz: 28, base: 0.66, comet: 1.9, dash: 0, sats: [[1.0, -0.14, 4.2]] },
    { r: 1.30, rx: 52, ry: -12, rz: -38, base: 0.58, comet: 1.8, dash: 72, sats: [[3.6, 0.17, 3.6]] },
    { r: 1.20, rx: 64, ry: 30, rz: 60, base: 0.62, comet: 1.9, dash: 0, sats: [[5.0, -0.20, 3.4], [1.8, -0.20, 2.6]] },
    { r: 1.58, rx: 16, ry: 0, rz: 12, base: 0.54, comet: 1.6, dash: 96, sats: [[2.2, 0.09, 3.0]] },
    { r: 1.40, rx: 40, ry: -24, rz: -62, base: 0.60, comet: 1.8, dash: 0, sats: [[4.4, 0.13, 3.8]] }
  ]
};
/* tiers by viewport width (the page's own breakpoints). Baked at mount: light list, fields/colour maps, mesh density, ramp.
   Live (re-applied on every setGeometry): pixel-ratio cap, light/speck shares, arcs alive. Light counts are the baked
   lists' (desktop 18,326 lights + 2,555 cores + 3,674 city points from the 4096² night map; mid/phone 9,961 + 1,369 +
   3,600 from the 2048² map); `lights`/`specks` here are the shares a narrower tier draws of a wider build. */
const TIERS = {
  desktop: { dpr: 1.5,  segs: 512, ramp: CFG.ramp,      lights: 24000, specks: CFG.specks,      arcs: CFG.arcs.alive },
  mid:     { dpr: 1.25, segs: 384, ramp: CFG.rampPhone, lights: 12000, specks: CFG.specksPhone, arcs: CFG.arcs.alivePhone },
  phone:   { dpr: 1.25, segs: 320, ramp: CFG.rampPhone, lights: 12000, specks: CFG.specksPhone, arcs: CFG.arcs.alivePhone }
};
const tierFor = w => w >= 1024 ? 'desktop' : w >= 768 ? 'mid' : 'phone';
const RAMP = [hex(0x7a4a10), hex(0xffb347), hex(0xffe9c4), hex(0xfff8ee)];   // deep amber → amber → warm white → white-hot (lights, cores, city layer)

/* static renders of this globe for the page (see CONTRACT.md): square, transparent, globe centre at the image centre,
   radius = k × width; the page sizes the image to R / k around the hero's cx, cy */
const POSTER = { k: 0.27, src1600: 'globe-assets/poster-hero-1600.webp', src800: 'globe-assets/poster-hero-800.webp', cta: 'globe-assets/poster-cta.webp' };

/* arc endpoints: [lat, lon, population in thousands, isUS] — Natural Earth 10 m populated places (public domain), the
   170 most populous world metros ≥ 1 M one per ~1.5°, plus 64 US metros ≥ 300 k one per ~1.2° (_sources/bake/metros.py) */
const METROS = [[35.69,139.75,35676,0],[40.75,-73.98,19040,1],[19.44,-99.13,19028,0],[19.02,72.86,18978,0],[-23.56,-46.63,18845,0],[28.67,77.23,15926,0],[31.22,121.44,14987,0],[22.5,88.32,14787,0],[23.73,90.41,12797,0],[-34.6,-58.4,12795,0],[33.99,-118.18,12500,1],[24.87,66.99,12130,0],[30.05,31.25,11893,0],[-22.92,-43.23,11748,0],[34.75,135.46,11294,0],[39.93,116.39,11106,0],[14.61,120.98,11100,0],[55.75,37.61,10452,0],[41.11,29.01,10061,0],[48.87,2.33,9904,0],[37.57,127.0,9796,0],[6.45,3.39,9466,0],[-6.17,106.83,9125,0],[41.83,-87.75,8990,1],[23.15,113.32,8829,0],[51.5,-0.12,8567,0],[-12.05,-77.05,8012,0],[35.67,51.42,7873,0],[-4.33,15.31,7843,0],[4.6,-74.08,7772,0],[30.58,114.27,7243,0],[13.09,80.28,7163,0],[25.04,121.57,6900,0],[12.97,77.56,6787,0],[13.75,100.52,6704,0],[31.56,74.35,6577,0],[29.57,106.59,6461,0],[17.4,78.48,6376,0],[16.53,80.52,5800,0],[-33.45,-70.67,5720,0],[25.79,-80.23,5585,1],[-19.91,-43.92,5575,0],[40.4,-3.69,5567,0],[23.03,72.58,5375,0],[10.78,106.69,5314,0],[43.7,-79.42,5213,0],[1.29,103.85,5184,0],[-8.84,13.23,5173,0],[33.34,44.39,5054,0],[41.38,2.18,4920,0],[32.82,-96.84,4798,1],[41.81,123.45,4787,0],[15.59,32.53,4754,0],[-33.92,151.18,4630,0],[59.94,30.31,4553,0],[22.33,91.8,4529,0],[33.83,-84.4,4506,1],[42.33,-71.07,4467,1],[24.64,46.77,4465,0],[29.82,-95.34,4459,1],[21.04,105.85,4378,0],[38.9,-77.01,4338,1],[20.67,-103.33,4198,0],[-37.82,144.97,4170,0],[31.2,29.95,4165,0],[30.67,104.07,4123,0],[42.33,-83.08,4101,1],[16.79,96.17,4088,0],[34.28,108.89,4009,0],[-30.05,-51.2,3917,0],[21.2,72.84,3842,0],[24.7,108.08,3830,0],[5.32,-4.04,3802,0],[-15.78,-47.92,3717,0],[39.93,32.86,3716,0],[25.67,-100.33,3712,0],[32.05,118.78,3679,0],[45.5,-73.58,3678,0],[26.58,106.72,3662,0],[-8.07,-34.92,3651,0],[45.75,126.65,3621,0],[-3.75,-38.58,3602,0],[43.81,87.57,3575,0],[33.54,-112.07,3551,1],[24.52,117.67,3531,0],[-12.97,-38.48,3484,0],[35.1,129.01,3480,0],[37.77,-122.42,3450,1],[-26.17,28.03,3435,0],[52.52,13.4,3406,0],[36.77,3.05,3354,0],[41.9,12.48,3339,0],[39.02,125.75,3300,0],[6.28,-75.58,3297,0],[34.52,69.18,3277,0],[37.98,23.73,3242,0],[-33.92,18.43,3215,0],[43.87,125.34,3183,0],[33.6,-7.62,3181,0],[38.92,121.63,3167,0],[26.46,80.32,3162,0],[12.0,8.52,3140,0],[32.08,34.77,3112,0],[9.04,38.7,3100,0],[-25.42,-49.32,3084,0],[47.57,-122.34,3074,1],[36.8,118.05,3061,0],[21.52,39.22,3012,0],[-1.28,36.81,3010,0],[10.5,-66.92,2985,0],[45.47,9.2,2945,0],[48.78,9.2,2945,0],[25.07,102.68,2931,0],[-6.8,39.27,2930,0],[26.92,75.81,2917,0],[32.82,-117.18,2916,1],[37.88,112.54,2913,0],[36.09,120.33,2866,0],[-7.25,112.75,2845,0],[38.73,-9.15,2812,0],[33.6,130.41,2792,0],[22.63,120.27,2769,0],[50.26,19.02,2746,0],[36.23,37.17,2738,0],[-29.86,30.98,2729,0],[50.44,30.52,2709,0],[34.76,113.66,2636,0],[44.98,-93.25,2616,1],[26.08,119.3,2606,0],[28.2,112.97,2604,0],[14.72,-17.48,2604,0],[38.44,27.15,2587,0],[36.06,103.79,2561,0],[43.08,141.34,2544,0],[-2.22,-79.92,2514,0],[5.41,100.33,2500,0],[18.44,-66.13,2479,0],[36.27,59.57,2469,0],[33.5,36.3,2466,0],[21.17,79.09,2454,0],[40.75,120.83,2426,0],[38.05,114.48,2417,0],[36.8,10.18,2412,0],[48.2,16.36,2400,0],[28.02,120.65,2350,0],[28.68,115.88,2350,0],[27.95,-82.46,2314,1],[49.27,-123.12,2313,0],[39.74,-104.99,2313,1],[3.4,-76.5,2254,0],[38.29,141.02,2250,0],[40.84,14.24,2250,0],[53.5,-2.25,2230,0],[38.64,-90.24,2199,1],[32.89,13.18,2189,0],[41.31,69.29,2184,0],[23.13,-82.37,2174,0],[22.82,108.32,2167,0],[-1.45,-48.48,2167,0],[25.63,85.13,2158,0],[18.47,-69.9,2154,0],[34.88,117.57,2145,0],[40.4,49.86,2122,0],[5.55,-0.22,2121,0],[3.58,98.65,2115,0],[-17.75,-63.23,2103,0],[10.73,-71.66,2072,0],[29.37,47.98,2063,0],[26.43,50.1,2055,0],[20.05,110.32,2046,0],[34.39,132.44,2045,0],[40.65,109.82,2036,0],[22.72,75.86,2026,0],[-16.72,-49.3,2022,0],[15.36,44.2,2008,0],[18.54,-72.34,1998,0],[33.0,112.53,1944,0],[44.44,26.1,1942,0],[4.06,9.71,1906,0],[41.47,-81.7,1890,1],[45.52,-122.68,1875,1],[40.08,113.3,1873,0],[-25.29,-57.64,1870,0],[34.75,72.35,1860,0],[-27.45,153.03,1860,0],[40.43,-80.0,1838,1],[36.21,-115.22,1823,1],[53.9,27.57,1805,0],[10.96,-74.8,1798,0],[53.55,10.0,1757,0],[34.45,115.65,1753,0],[-3.1,-60.0,1753,0],[39.16,-84.46,1636,1],[36.85,-75.98,1491,1],[29.49,-98.51,1473,1],[39.11,-94.61,1469,1],[39.75,-86.17,1436,1],[43.05,-87.92,1388,1],[39.98,-82.99,1270,1],[35.82,-78.64,1164,1],[33.53,-86.83,1128,1],[35.12,-90.0,1081,1],[42.88,-78.88,1016,1],[35.21,-80.83,995,1],[30.33,-81.67,988,1],[40.78,-111.93,966,1],[38.23,-85.75,948,1],[36.12,-95.93,947,1],[41.77,-72.68,913,1],[37.55,-77.45,912,1],[35.1,-106.64,899,1],[41.24,-96.01,877,1],[36.17,-86.78,877,1],[42.67,-73.82,871,1],[32.21,-110.89,823,1],[35.47,-97.52,788,1],[21.31,-157.86,786,1],[30.0,-90.04,785,1],[31.78,-106.51,753,1],[43.05,-76.15,663,1],[35.97,-83.92,655,1],[36.75,-119.77,616,1],[42.96,-85.67,536,1],[40.27,-76.89,529,1],[35.37,-119.02,443,1],[27.51,-99.51,435,1],[32.79,-79.99,412,1],[37.72,-97.33,402,1],[38.95,-92.33,398,1],[41.58,-93.62,381,1],[26.2,-98.23,364,1],[34.85,-82.39,351,1],[47.67,-117.42,348,1],[43.61,-116.23,338,1]];

/* -------------------------------------------------------------- shaders */
const SPHERE_VS = `
uniform sampler2D uCoastMap; uniform float uPlate; uniform float uRamp;
varying vec2 vUv; varying vec3 vN; varying vec3 vP; varying vec3 vUp;
void main(){
  vUv = uv;
  float d = (texture2D(uCoastMap, uv).r - 0.5) * 21.25;
  float land = smoothstep(-uRamp, uRamp, d);
  /* the plates settle back into the sphere toward the limb, so the silhouette stays a clean circle (no stair-steps) */
  vec3 nrm = normalize(position);
  vec3 nv = normalize(normalMatrix * nrm);
  vec3 pv = (modelViewMatrix * vec4(position, 1.0)).xyz;
  float limb = smoothstep(0.03, 0.26, dot(nv, normalize(-pv)));
  vec3 p = position * (1.0 + uPlate * land * limb);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vP = mv.xyz; vN = nv; vUp = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
  gl_Position = projectionMatrix * mv;
}`;
const SPHERE_FS = `
uniform sampler2D uCoastMap; uniform sampler2D uFields; uniform sampler2D uColor; uniform vec2 uTexel; uniform vec2 uTexelR;
uniform float uPlate, uBump, uEdge, uGlint, uTopo, uSheen, uWash, uDots, uDotR, uOceanDot, uLandDot, uCoast, uGrey, uGreyLo, uGreyLift, uKeyRim, uLift, uDesat;
uniform float uShelf, uShallow, uGlintO, uGlintPow, uAtmo, uEdgeLit; uniform vec3 uHill; uniform vec2 uAtmoLimb;
uniform vec3 uKey; uniform vec3 uRim; uniform vec3 uGlintL;
varying vec2 vUv; varying vec3 vN; varying vec3 vP; varying vec3 vUp;
float sd(vec4 s){ return (s.r - 0.5) * 21.25; }
float hgt(float d){ return smoothstep(-2.0, 2.0, d); }
void main(){
  vec4 s  = texture2D(uCoastMap, vUv);
  vec4 sR = texture2D(uCoastMap, vUv + vec2(uTexel.x, 0.0)), sL = texture2D(uCoastMap, vUv - vec2(uTexel.x, 0.0));
  vec4 sU = texture2D(uCoastMap, vUv + vec2(0.0, uTexel.y)), sD = texture2D(uCoastMap, vUv - vec2(0.0, uTexel.y));
  /* fields: R elevation (relief), G ocean shallowness, B city-light wash — four taps give the gradient and the means */
  vec4 fR = texture2D(uFields, vUv + vec2(uTexelR.x, 0.0)), fL = texture2D(uFields, vUv - vec2(uTexelR.x, 0.0));
  vec4 fU = texture2D(uFields, vUv + vec2(0.0, uTexelR.y)), fD = texture2D(uFields, vUv - vec2(0.0, uTexelR.y));
  vec4 f0 = (fR + fL + fU + fD) * 0.25;
  float eR = fR.r, eL = fL.r, eU = fU.r, eD = fD.r, e0 = f0.r;
  float d = sd(s);
  float land = smoothstep(-1.0, 1.0, d);
  float lat = (vUv.y - 0.5) * 3.14159265;
  float cosLat = max(0.12, cos(lat));
  vec3 n = normalize(vN); vec3 up = normalize(vUp);
  vec3 E = cross(up, n); float el = length(E); E = el > 1e-4 ? E / el : vec3(1.0, 0.0, 0.0);
  vec3 Nn = cross(n, E);
  /* bevel normal: plate height gradient (narrow, crisp) + terrain relief inside the plates */
  float kx = 0.5 / (6.2831853 * cosLat * uTexel.x), ky = 0.5 / (3.1415927 * uTexel.y);
  float kxR = 0.5 / (6.2831853 * cosLat * uTexelR.x), kyR = 0.5 / (3.1415927 * uTexelR.y);
  float teR = (eR - eL) * kxR * land, teN = (eU - eD) * kyR * land;                                   /* elevation gradient (per radian of arc) */
  float se = uPlate * uBump * (hgt(sd(sR)) - hgt(sd(sL))) * kx + uTopo * teR;
  float sn = uPlate * uBump * (hgt(sd(sU)) - hgt(sd(sD))) * ky + uTopo * teN;
  vec3 np = normalize(n - se * E - sn * Nn);
  /* terrain hillshade: how much the relief alone turns the surface toward (or away from) the key light; applied as a
     factor after the luma knee, so mountains stay legible on bright land and where the key light is near-frontal */
  vec3 nRel = normalize(n - uHill.y * (teR * E + teN * Nn));
  float hillRaw = dot(nRel, uKey) - dot(n, uKey);                                   /* × the gain (uHill.x, or uHill.z on arid land) below */
  vec3 V = normalize(-vP);
  float ndv = max(0.0, dot(n, V));
  float facing = smoothstep(0.06, 0.40, ndv);
  float diff = max(0.0, dot(np, uKey));
  float ndlS = dot(n, uKey);
  float diffFlat = max(0.0, ndlS);
  /* dot matrix: equal-arc cells, round(uDots·cos lat) columns per row, round dots, AA by footprint, sub-pixel cells → their mean */
  float rows = uDots * 0.5;
  float row = floor(vUv.y * rows);
  float rowLat = ((row + 0.5) / rows - 0.5) * 3.14159265;
  float cols = max(6.0, floor(uDots * cos(rowLat) + 0.5));
  vec2 cell = vec2(vUv.x * cols, vUv.y * rows);
  vec2 g = fract(cell) - 0.5;
  float dd = length(g);
  float dux = fwidth(vUv.x); dux = min(dux, 1.0 - dux);
  float w = max(dux * cols, fwidth(vUv.y) * rows);
  float aa = max(0.04, 0.7 * w);
  float dm = 1.0 - smoothstep(uDotR - aa, uDotR + aa, dd);
  float cover = 3.14159265 * uDotR * uDotR;
  dm = mix(dm, cover, smoothstep(0.26, 0.62, w));
  /* ocean: deep-navy dots on a very dark blue; the continental shelf lifts toward teal, tropical shallow banks toward
     turquoise (B = baked shallowness), on the dots and faintly between them */
  float shallow = f0.g;
  float trop = 1.0 - smoothstep(0.30, 0.56, abs(lat));
  vec3 shelfCol = mix(vec3(0.10, 0.36, 0.42), vec3(0.18, 0.62, 0.60), smoothstep(0.45, 0.95, shallow) * trop);
  float shelfK = shallow * (uShelf + uShallow * trop * smoothstep(0.45, 0.95, shallow));
  vec3 ocean = mix(vec3(0.012, 0.030, 0.068), vec3(0.18, 0.36, 0.64) * uOceanDot, dm);
  /* land: the graded colour map, lifted and slightly desaturated; the luma cap keeps the hue */
  float tone = (0.95 + 0.22 * e0) * 0.92;
  vec3 cm = texture2D(uColor, vUv).rgb;
  float arid = smoothstep(0.02, 0.09, cm.r - cm.g);                                               /* sand and rock (red over green); forests, tundra and ice are 0 */
  float hill = clamp(hillRaw * mix(uHill.x, uHill.z, arid), -0.30, 0.12);   /* the lit side gains at most 12 %: ice at the knee (~0.44) stays under the 0.52 bloom threshold */
  cm = mix(cm, vec3(dot(cm, vec3(0.30, 0.59, 0.11))), uDesat) * uLift;
  float cmL = dot(cm, vec3(0.30, 0.59, 0.11));
  cm *= cmL > 1.0 ? 1.0 / cmL : 1.0;
  vec3 plateDot = cm * uLandDot * tone;
  vec3 plate = mix(plateDot * 0.62, plateDot, dm);                                                 /* plates: the coloured slab with a faint weave */
  float greyK = uGrey * smoothstep(uGreyLo, 1.0, diffFlat);
  plate = mix(plate, vec3(dot(plate, vec3(0.30, 0.59, 0.11))) * uGreyLift, greyK);
  vec3 alb = mix(ocean, plate, land);
  float coast = 1.0 - smoothstep(0.0, 1.6, abs(d));
  float keyLit = smoothstep(0.5, 1.0, diffFlat);
  float matte = 1.0 - 0.6 * keyLit;                                                                 /* where the key light hits, the coast dots, the bevel and the glint add less */
  alb = mix(alb, vec3(0.94, 0.86, 0.68) * (0.30 + 0.70 * diffFlat), coast * dm * uCoast * smoothstep(0.15, 0.7, diffFlat) * matte);   /* pale sand coast dots */
  vec3 col = alb * (0.16 + 0.84 * pow(diff, 0.7)) * vec3(1.0, 0.97, 0.92);                        /* a near-neutral, faintly warm key light */
  col += alb * vec3(0.40, 0.60, 1.0) * max(0.0, dot(np, uRim)) * 0.32;                           /* cool blue fill from the rim light: the dark side keeps its plate texture */
  /* the raised plate shades the ocean beside it: a soft dark band just off the coast, deeper away from the key light */
  float ao = (1.0 - smoothstep(0.0, 4.0, -d)) * (1.0 - land);
  col *= 1.0 - ao * (0.40 + 0.40 * (1.0 - diffFlat));
  /* the shelf / shallow banks light up after the slab shadow (which would otherwise swallow the near-coast band): teal on
     the dots, faint between them, brighter on the key-lit side */
  col += shelfCol * shelfK * (1.0 - land) * mix(0.18, 1.0, dm) * (0.30 + 0.70 * diffFlat);
  /* ocean light: v2.1.2's small blue-white sheen on the key shoulder, or (glintO) a warm sun glint that catches the dots */
  vec3 Hh = normalize(uKey + V);
  float nh = max(0.0, dot(n, normalize(uGlintL + V)));                                            /* the glint's own light (CFG glintDir) */
  float spec = pow(max(0.0, dot(np, Hh)), 18.0);
  col += vec3(0.28, 0.42, 0.62) * spec * (1.0 - land) * uSheen * diffFlat * diffFlat * (1.0 - step(0.001, uGlintO));
  /* the body never enters the bloom: soft knee at 0.38 with slope 0.10 above it keeps the brightest slabs under ~0.44;
     the bevel, glint, wash and rim terms are added after it */
  float Lb = dot(col, vec3(0.30, 0.59, 0.11));
  col *= Lb > 0.38 ? (0.38 + (Lb - 0.38) * 0.10) / Lb : 1.0;
  col *= 1.0 + hill * land * facing;
  /* warm sun glint on the ocean (after the knee, so it keeps its shape): a soft lobe around the key light's reflection that
     catches the dots more than the gaps; low, so nothing blows out */
  col += vec3(1.0, 0.90, 0.74) * pow(nh, uGlintPow) * (1.0 - land) * uGlintO * mix(0.30, 1.0, dm) * diffFlat;
  /* plate edge light: the bevel faces the key light on one side (pale cream) and away on the other (sand-brown); fades at the limb */
  float band = 1.0 - smoothstep(0.0, 2.4, abs(d));
  float lit = 0.2 + 0.8 * diff;
  float whiteFade = smoothstep(0.22, 0.50, ndv);
  vec3 edgeCol = mix(vec3(0.26, 0.19, 0.10), vec3(0.98, 0.92, 0.78), band * band * lit * whiteFade);
  edgeCol = mix(edgeCol, vec3(dot(edgeCol, vec3(0.30, 0.59, 0.11))), 0.5 * keyLit);
  col += edgeCol * band * uEdge * (0.22 + 0.78 * lit) * facing * matte * (1.0 + uEdgeLit * band * band * lit * whiteFade);   /* edgeLit: the cream crest on the sunlit side */
  float glint = pow(max(0.0, dot(np, Hh)), 48.0) * band;
  col += vec3(1.0, 0.96, 0.86) * glint * uGlint * facing * whiteFade * matte;
  /* warm amber wash under the big city clusters (fields B = baked smoothstep of the night luma) */
  col += vec3(0.34, 0.19, 0.05) * f0.b * uWash;
  /* atmosphere. atmo 0: v2.1.2's soft blue-white fresnel wrapping the lower-right (rim) limb + a hairline pale rim toward
     the key. atmo 1: a thin blue limb brightest where the key light hits it, the rim side kept faint */
  float fr = pow(1.0 - ndv, 3.2);
  float rimLit = max(0.0, dot(n, uRim));
  float keyLimb = smoothstep(-0.25, 0.75, ndlS);
  vec3 atmo0 = vec3(0.62, 0.82, 1.0) * fr * (0.10 + 0.90 * rimLit) * 0.55 + vec3(0.78, 0.90, 1.0) * pow(1.0 - ndv, 12.0) * rimLit * 0.55;
  vec3 atmo1 = vec3(0.50, 0.76, 1.0) * pow(1.0 - ndv, uAtmoLimb.y) * (0.12 + 0.88 * keyLimb) * 0.80 * uAtmoLimb.x   /* thin limb, lit side (CFG limb, limbPow) */
             + vec3(0.62, 0.82, 1.0) * fr * rimLit * 0.22                                                    /* the rim side, faint */
             + vec3(0.80, 0.91, 1.0) * pow(1.0 - ndv, 12.0) * (0.30 * rimLit + 0.32 * keyLimb * uAtmoLimb.x) * 0.55;   /* hairline crescent */
  col += mix(atmo0, atmo1, uAtmo);
  float keyEdge = pow(1.0 - ndv, 14.0) * diffFlat;
  col += vec3(1.0, 0.97, 0.92) * keyEdge * uKeyRim;
  gl_FragColor = vec4(col, 1.0);
}`;
const DOT_FS = `
varying vec4 vCol;
void main(){
  vec2 q = gl_PointCoord - 0.5; float r2 = dot(q, q) * 4.0;
  if (r2 > 1.0) discard;
  gl_FragColor = vCol * (1.0 - smoothstep(0.2, 1.0, r2));
}`;
const LIGHT_VS = `
attribute float aSize; attribute vec4 aColor; attribute float aSeed;
uniform float uSizeK; uniform float uTime; uniform float uTwinkle; uniform float uFade; uniform vec2 uLimb; uniform vec3 uKey; uniform float uDayNight; uniform float uNight; uniform float uMinPx;
varying vec4 vCol;
void main(){
  vec3 nv = normalize(normalMatrix * normalize(position));
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float facing = dot(nv, normalize(-mv.xyz));
  float a = aColor.a * uFade * (0.84 + 0.16 * uTwinkle * sin(uTime * (1.1 + 2.3 * aSeed) + aSeed * 43.0));
  a *= smoothstep(uLimb.x, uLimb.y, facing);          /* limb fade: no stacked white thread where a cluster meets the silhouette */
  a *= mix(uDayNight, uNight, smoothstep(0.55, -0.15, dot(nv, uKey)));   /* strongest on the side away from the key light */
  vCol = vec4(aColor.rgb * a, a);
  gl_PointSize = max(uMinPx, aSize * uSizeK / max(0.05, -mv.z));   /* never under one CSS pixel: the lights keep their footprint at any pixel ratio */
  gl_Position = projectionMatrix * mv;
}`;
const RIBBON = `
  vec4 cp = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 np = projectionMatrix * modelViewMatrix * vec4(aNext, 1.0);
  vec2 cs = cp.xy / cp.w * uViewport * 0.5;
  vec2 ns = np.xy / np.w * uViewport * 0.5;
  vec2 dir = ns - cs; float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x) * (aSide * uWidth);
  cp.xy += nrm / (uViewport * 0.5) * cp.w;
  vSide = aSide;
  gl_Position = cp;`;
const RING_VS = `
attribute vec3 aNext; attribute float aSide; attribute float aAng;
uniform vec2 uViewport; uniform float uWidth; uniform float uCenterZ;
varying float vSide; varying float vAng; varying float vFade;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFade = mix(0.42, 1.0, smoothstep(-1.1, 1.1, mv.z - uCenterZ));
  vAng = aAng;
  ${RIBBON}
}`;
const RING_FS = `
uniform vec3 uColor; uniform float uBase; uniform float uComet; uniform float uOffset; uniform float uDash; uniform float uAlpha;
varying float vSide; varying float vAng; varying float vFade;
void main(){
  float edge = 1.0 - smoothstep(0.3, 1.0, abs(vSide));
  float d = fract((uOffset - vAng) / 6.2831853);
  float comet = exp(-d * 7.0);
  float dash = 1.0;
  if (uDash > 0.5) dash = step(0.45, fract(vAng * uDash / 6.2831853));
  float a = (uBase + uComet * comet) * vFade * edge * dash * uAlpha;
  vec3 c = mix(uColor, vec3(1.0, 0.98, 0.94), comet * 0.65);   /* warm-white comet */
  gl_FragColor = vec4(c * a, a);
}`;
const ARC_VS = `
attribute vec3 aNext; attribute float aSide; attribute float aT; attribute float aArc;
uniform vec2 uViewport; uniform float uWidth;
uniform float uHead[MAXA]; uniform float uTail[MAXA]; uniform float uGlow[MAXA]; uniform float uPulse[MAXA];
varying float vSide; varying float vA; varying float vP;
void main(){
  int ai = int(aArc + 0.5);
  float head = uHead[ai]; float tail = uTail[ai]; float glow = uGlow[ai]; float pulse = uPulse[ai];
  float vis = smoothstep(tail - 0.04, tail + 0.005, aT) * (1.0 - smoothstep(head - 0.005, head + 0.04, aT));
  vA = vis * glow;
  float tip = head < 0.999 ? exp(-(head - aT) * 10.0) : 0.0;
  float bead = pulse >= 0.0 ? exp(-abs(aT - pulse) * 18.0) : 0.0;
  vP = clamp(max(tip, bead), 0.0, 1.0);
  ${RIBBON}
}`;
const ARC_FS = `
uniform vec3 uColor; uniform vec3 uHot; uniform float uAlpha;
varying float vSide; varying float vA; varying float vP;
void main(){
  float edge = 1.0 - smoothstep(0.25, 1.0, abs(vSide));
  float a = vA * edge * uAlpha * (0.55 + 0.45 * vP);
  gl_FragColor = vec4(mix(uColor, uHot, vP * vP) * a, a);
}`;
const FLASH_VS = `
attribute float aArc; attribute float aEnd;
uniform float uHead[MAXA]; uniform float uTail[MAXA]; uniform float uGlow[MAXA]; uniform float uSizeK; uniform vec3 uFlash; uniform float uMinPx;
varying vec4 vCol;
void main(){
  int ai = int(aArc + 0.5);
  float head = uHead[ai]; float tail = uTail[ai]; float glow = uGlow[ai];
  float f = aEnd < 0.5 ? (1.0 - smoothstep(0.0, 0.35, head)) * smoothstep(0.0, 0.05, head) : smoothstep(0.8, 1.0, head) * (1.0 - smoothstep(0.0, 0.5, tail));
  f *= glow;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float a = f * 0.55;
  vCol = vec4(uFlash * a, a);
  gl_PointSize = max(uMinPx, (2.0 + 4.5 * f) * uSizeK / max(0.05, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;
const SAT_VS = `
attribute float aAng0; attribute float aSpeed; attribute float aSize;
uniform float uTime; uniform float uSizeK; uniform float uMinPx;
varying vec4 vCol;
void main(){
  float a = aAng0 + uTime * aSpeed;
  vec4 mv = modelViewMatrix * vec4(cos(a), 0.0, sin(a), 1.0);
  vCol = vec4(1.0, 0.97, 0.92, 0.9);   /* warm-white satellites */
  gl_PointSize = max(uMinPx, aSize * uSizeK / max(0.05, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;
const SPECK_VS = `
attribute float aSize; attribute float aAlpha; attribute float aPhase;
uniform float uTime; uniform float uSizeK; uniform float uMinPx; uniform float uIntro;
varying vec4 vCol;
void main(){
  vec3 p = position + 0.035 * vec3(sin(uTime * 0.31 + aPhase), cos(uTime * 0.23 + aPhase * 1.7), sin(uTime * 0.17 + aPhase * 2.3));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float a = aAlpha * (0.75 + 0.25 * sin(uTime * 0.9 + aPhase * 5.0)) * uIntro;
  vec3 sc = fract(aPhase * 0.137) < 0.14 ? vec3(0.72, 0.84, 1.0) : vec3(1.0, 0.94, 0.84);   /* warm-white specks, ~1 in 7 blue-white */
  vCol = vec4(sc * a, a);
  gl_PointSize = max(uMinPx, aSize * uSizeK / max(0.05, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;
const HALO_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const HALO_FS = `
uniform float uAlpha; uniform vec2 uDir; varying vec2 vUv;
void main(){
  vec2 q = (vUv - 0.5) * 2.6; float r = length(q);
  float a = (1.0 - smoothstep(1.0, 1.3, r)) * smoothstep(0.97, 1.015, r);
  float dir = 0.55 + 0.45 * dot(normalize(q + vec2(1e-5, 0.0)), uDir);
  a *= uAlpha * dir;
  gl_FragColor = vec4(vec3(0.40, 0.72, 0.92) * a, a);   /* soft blue halo */
}`;
/* UnrealBloomPass's blur writes alpha = 1 and its copy pass adds with SRC_ALPHA, which paints the whole
   transparent canvas opaque black. This blur carries alpha through the mips instead (same defines). */
const BLUR_ALPHA_FS = `#include <common>
varying vec2 vUv; uniform sampler2D colorTexture; uniform vec2 texSize; uniform vec2 direction;
float gaussianPdf(in float x, in float sigma){ return 0.39894 * exp(-0.5 * x * x / (sigma * sigma)) / sigma; }
void main(){
  vec2 invSize = 1.0 / texSize; float fSigma = float(SIGMA);
  float weightSum = gaussianPdf(0.0, fSigma);
  vec4 sum = texture2D(colorTexture, vUv) * weightSum;
  for (int i = 1; i < KERNEL_RADIUS; i++){
    float x = float(i); float w = gaussianPdf(x, fSigma);
    vec2 uvOffset = direction * invSize * x;
    sum += (texture2D(colorTexture, vUv + uvOffset) + texture2D(colorTexture, vUv - uvOffset)) * w;
    weightSum += 2.0 * w;
  }
  gl_FragColor = sum / weightSum;
}`;

/* ------------------------------------------------------------ data job */
/* Runs in a Worker (its source is this function's text, so it must stay self-contained) or, without Worker support, on
   the main thread. Fetches the three textures and the tier's light list, decodes the images with createImageBitmap
   (premultiplyAlpha / colorSpaceConversion 'none': they are data), turns the light list into point attributes and
   builds the sphere mesh arrays. A failed request rejects with kind 'fetch'.
   lights-*.bin (little-endian): 'BMLT', u16 version 1, u16 layer count, a u32 point count per layer, then per layer
   (lights, cores, city): u16 u[n] (longitude, 0 = 180°W), u16 v[n] (0 = north pole), u8 t[n] (heat), u8 d[n]
   (coast distance at the point, 128 + 8·texels of the 2048 field); 6n bytes per layer, so every u16 array stays aligned. The points were sampled
   offline from the night map by the v2.1.2 code (acceptance ∝ brightness², land-gated) and stored in shuffled order,
   so any prefix is a uniform subsample (the low tier and narrower tiers draw a prefix). */
async function DATA_JOB(job) {
  const transfer = [], out = {};
  const err = (kind, message) => { const e = new Error(message); e.kind = kind; return e; };
  async function get(url, buf) {
    let r;
    try { r = await fetch(url, { credentials: 'same-origin' }); } catch (e) { throw err('fetch', 'fetch failed ' + url); }
    if (!r.ok) throw err('fetch', 'fetch ' + r.status + ' ' + url);
    return buf ? r.arrayBuffer() : r.blob();
  }
  async function image(url) {
    const b = await get(url, false);
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); } catch (e) {}
      try { return await createImageBitmap(b); } catch (e) {}
    }
    return b;                                   // no ImageBitmap here: the main thread decodes the blob
  }
  const imgs = Promise.all([image(job.urls.coast), image(job.urls.fields), image(job.urls.color)]);
  const buf = await get(job.urls.lights, true);
  /* light list → positions (lifted onto the plates with the tier's ramp), colours (the amber ramp), sizes, seeds */
  const dv = new DataView(buf);
  if (buf.byteLength < 8 || dv.getUint32(0, true) !== 0x544C4D42 || dv.getUint16(4, true) !== 1) throw err('decode', 'not a BMLT v1 light list: ' + job.urls.lights);
  const nLayers = dv.getUint16(6, true), R = job.ramp, D2R = Math.PI / 180;
  const rampAt = t => { t = Math.min(1, Math.max(0, t)) * 3; const i = Math.min(2, Math.floor(t)), f = t - i, a = R[i], b = R[i + 1]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; };
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  /* per layer: ramp start, ramp span, alpha start, alpha span, size start, size span (v2.1.2's values) */
  const STY = [[0.08, 0.55, 0.20, 0.50, 1.0, 1.2], [0.45, 0.40, 0.31, 0.26, 2.2, 1.5], [0.05, 0.22, 0.11, 0.15, 0.9, 0.7]];
  let seed = 0x9E3779B9;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  let o = 8 + nLayers * 4;
  out.layers = [];
  for (let li = 0; li < nLayers; li++) {
    const n = dv.getUint32(8 + li * 4, true);
    if (o + n * 6 > buf.byteLength) throw err('decode', 'truncated light list');
    const U = new Uint16Array(buf, o, n); o += n * 2;
    const V = new Uint16Array(buf, o, n); o += n * 2;
    const Tt = new Uint8Array(buf, o, n); o += n;
    const Dd = new Uint8Array(buf, o, n); o += n;
    const pos = new Float32Array(n * 3), col = new Uint8Array(n * 4), size = new Float32Array(n), sd = new Float32Array(n), st = STY[Math.min(li, 2)];
    for (let i = 0; i < n; i++) {
      const phi = U[i] / 65536 * 2 * Math.PI, latR = (90 - V[i] / 65535 * 180) * D2R, cl = Math.cos(latR);
      const h = 1.004 + job.plate * sm(-job.rampT, job.rampT, (Dd[i] - 128) / 8) + 0.0025;
      pos[i * 3] = -Math.cos(phi) * cl * h; pos[i * 3 + 1] = Math.sin(latR) * h; pos[i * 3 + 2] = Math.sin(phi) * cl * h;
      const t = Tt[i] / 255, c = rampAt(st[0] + st[1] * t);
      col[i * 4] = c[0] * 255; col[i * 4 + 1] = c[1] * 255; col[i * 4 + 2] = c[2] * 255; col[i * 4 + 3] = (st[2] + st[3] * t) * 255;
      size[i] = st[4] + st[5] * t; sd[i] = rnd();
    }
    out.layers.push({ n, pos, col, size, seed: sd });
    transfer.push(pos.buffer, col.buffer, size.buffer, sd.buffer);
  }
  /* the sphere: three.js SphereGeometry(1, segs, segs/2)'s vertex order and uv layout, positions + uv only (the shader
     takes the normal from the position) */
  const ws = job.segs, hs = job.segs >> 1, nv = (ws + 1) * (hs + 1);
  const P = new Float32Array(nv * 3), UV = new Float32Array(nv * 2), I = new Uint32Array(ws * (hs - 1) * 6);
  for (let iy = 0, k = 0; iy <= hs; iy++) {
    const v = iy / hs, uOff = iy === 0 ? 0.5 / ws : iy === hs ? -0.5 / ws : 0, st = Math.sin(v * Math.PI), ct = Math.cos(v * Math.PI);
    for (let ix = 0; ix <= ws; ix++, k++) {
      const u = ix / ws;
      P[k * 3] = -Math.cos(u * 2 * Math.PI) * st; P[k * 3 + 1] = ct; P[k * 3 + 2] = Math.sin(u * 2 * Math.PI) * st;
      UV[k * 2] = u + uOff; UV[k * 2 + 1] = 1 - v;
    }
  }
  let q = 0;
  for (let iy = 0; iy < hs; iy++) for (let ix = 0; ix < ws; ix++) {
    const a = iy * (ws + 1) + ix + 1, b = iy * (ws + 1) + ix, c = (iy + 1) * (ws + 1) + ix, d = (iy + 1) * (ws + 1) + ix + 1;
    if (iy !== 0) { I[q++] = a; I[q++] = b; I[q++] = d; }
    if (iy !== hs - 1) { I[q++] = b; I[q++] = c; I[q++] = d; }
  }
  out.sphere = { pos: P, uv: UV, idx: I };
  transfer.push(P.buffer, UV.buffer, I.buffer);
  const im = await imgs;
  out.coast = im[0]; out.fields = im[1]; out.color = im[2];
  for (const b of im) if (b && typeof b.close === 'function') transfer.push(b);
  return { out, transfer };
}
const WORKER_SRC = `'use strict';
const DATA_JOB = ${DATA_JOB.toString()};
self.onmessage = async function (e) {
  try { const r = await DATA_JOB(e.data); self.postMessage({ ok: true, out: r.out }, r.transfer); }
  catch (er) { self.postMessage({ ok: false, kind: er && er.kind || 'decode', error: String(er && er.message || er) }); }
};`;
function runJob(job) {
  return new Promise((res, rej) => {
    let url = null, w = null;
    try {
      if (!window.Worker || !window.Blob || !window.URL) throw new Error('no worker');
      url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })); w = new Worker(url);
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      return DATA_JOB(job).then(r => res(r.out), rej);     // no Worker: same job on the main thread
    }
    const done = () => { try { w.terminate(); } catch (e) {} URL.revokeObjectURL(url); };
    w.onmessage = ev => { done(); if (ev.data && ev.data.ok) res(ev.data.out); else { const e = new Error(ev.data && ev.data.error || 'worker failed'); e.kind = ev.data && ev.data.kind || 'decode'; rej(e); } };
    w.onerror = ev => { done(); try { ev.preventDefault(); } catch (_) {} DATA_JOB(job).then(r => res(r.out), rej); };   // a worker that cannot start (CSP): main thread
    w.postMessage(job);
  });
}

/* ------------------------------------------------------- GL helpers */
/* ribbon loop on the unit circle (XZ plane): 2 vertices per point, aNext for the screen-space direction */
function ringGeometry(n) {
  const pos = new Float32Array(n * 6), nxt = new Float32Array(n * 6), side = new Float32Array(n * 2), ang = new Float32Array(n * 2), idx = new Uint16Array(n * 6);
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU, a2 = ((i + 1) % n) / n * TAU, x = Math.cos(a), z = Math.sin(a), x2 = Math.cos(a2), z2 = Math.sin(a2);
    for (let s = 0; s < 2; s++) { const j = i * 2 + s; pos[j * 3] = x; pos[j * 3 + 2] = z; nxt[j * 3] = x2; nxt[j * 3 + 2] = z2; side[j] = s ? 1 : -1; ang[j] = a; }
    const k = i * 6, a0 = i * 2, b0 = ((i + 1) % n) * 2;
    idx[k] = a0; idx[k + 1] = a0 + 1; idx[k + 2] = b0; idx[k + 3] = a0 + 1; idx[k + 4] = b0 + 1; idx[k + 5] = b0;
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('aNext', new T.BufferAttribute(nxt, 3));
  g.setAttribute('aSide', new T.BufferAttribute(side, 1)); g.setAttribute('aAng', new T.BufferAttribute(ang, 1));
  g.setIndex(new T.BufferAttribute(idx, 1));
  return g;
}
function additive(params) {
  return new T.ShaderMaterial(Object.assign({ transparent: true, depthTest: true, depthWrite: false, blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.OneFactor, blendDst: T.OneFactor, blendSrcAlpha: T.OneFactor, blendDstAlpha: T.OneFactor }, params));
}
/* the screen-space ribbons (arcs, rings) face either way as they turn, so they draw with culling off. three r147 draws a
   transparent DoubleSide material twice — back faces, then front faces — and sets material.needsUpdate around each pass,
   which re-resolves the program twice per object per frame (~1.4 MB/s of garbage with six rings). transparent: false gives
   one pass with culling off and keeps the additive blend; with no depth writes the order of additive draws doesn't change the
   sum, and the ribbons still depth-test against the sphere, which draws before them (opaque list, lower material id) */
function ribbon(params) { return additive(Object.assign({ transparent: false, side: T.DoubleSide }, params)); }
/* a 1×1 stand-in so materials (and their programs) exist before the data arrives */
function stubTexture() { const t = new T.DataTexture(new Uint8Array([128, 0, 0, 255]), 1, 1, T.RGBAFormat, T.UnsignedByteType); t.needsUpdate = true; return t; }
function pointGeometry(n, pos, col, size, seed) {
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos || new Float32Array(3), 3)); g.setAttribute('aColor', new T.BufferAttribute(col || new Uint8Array(4), 4, true));
  g.setAttribute('aSize', new T.BufferAttribute(size || new Float32Array(1), 1)); g.setAttribute('aSeed', new T.BufferAttribute(seed || new Float32Array(1), 1));
  if (!pos) g.setDrawRange(0, 0);
  return g;
}

/* the six r147 pass files: already inside the custom vendor/three.min.js; with a stock three.min.js they are loaded in order
   from assetBase + 'vendor/' (EffectComposer defines THREE.Pass first) */
const PASS_FILES = ['EffectComposer', 'CopyShader', 'LuminosityHighPassShader', 'RenderPass', 'ShaderPass', 'UnrealBloomPass'];
const passesPresent = () => !!(T.EffectComposer && T.RenderPass && T.ShaderPass && T.UnrealBloomPass && T.CopyShader && T.LuminosityHighPassShader);
let passLoad = null;
function ensurePasses(base) {
  if (passesPresent()) return Promise.resolve();
  if (!passLoad) passLoad = new Promise((res, rej) => {
    let n = 0;
    for (const nm of PASS_FILES) {
      const s = document.createElement('script'); s.async = false; s.src = base + 'vendor/' + nm + '.js';
      s.onload = () => { if (++n === PASS_FILES.length) res(); };
      s.onerror = () => rej(new Error('BMGlobe: failed to load ' + nm + '.js'));
      document.head.appendChild(s);
    }
  }).then(() => { if (!passesPresent()) throw new Error('BMGlobe: bloom passes did not register'); })
    .catch(err => { passLoad = null; throw err; });           // a failed load is not cached: a later mount() fetches the files again
  return passLoad;
}

/* software rasterisers and other renderers that cannot carry this scene (UNMASKED_RENDERER_WEBGL) */
const SOFT_GL = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i;
function rendererName(gl) {
  try { const x = gl.getExtension('WEBGL_debug_renderer_info'); return String((x && gl.getParameter(x.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || ''); } catch (e) { return ''; }
}

/* ================================================================ mount */
function mount(container, opts) {
  opts = opts || {};
  T = window.THREE;
  if (!T || !T.WebGLRenderer) throw new Error('BMGlobe: three.js is not loaded');
  if (!container) throw new Error('BMGlobe: no container');
  mark('bmglobe:mount');
  const assetBase = opts.assetBase || 'globe-assets/';
  const external = opts.loop === 'external';
  const layers = Object.assign({ specks: true, arcs: true, rings: true }, opts.layers || {});   // the posters render without specks/arcs (and the CTA horizon without rings)
  const view = Object.assign({ lon0: CFG.lon0, tiltX: CFG.tiltX, tiltZ: CFG.tiltZ }, opts.view || {});
  let RM = !!opts.reducedMotion;
  const cb = k => typeof opts[k] === 'function' ? opts[k] : function () {};
  const onReady = cb('onReady'), onFail = cb('onFail'), onLostCb = cb('onLost'), onRestoredCb = cb('onRestored');
  const rnd = mulberry32(20261108);
  const viewW = () => window.innerWidth || (opts.geometry && opts.geometry.W) || 1280;
  let tier = tierFor(opts.width || viewW());
  const builtName = tier, built = TIERS[tier];
  const RAMPT = built.ramp;

  let ready = false, paused = false, dead = false, failed = false, lost = false, pendingReady = false, hadLoss = false;
  function fail(err) {
    if (failed || dead) return; failed = true;
    try { console.debug('[orbit] WebGL globe fell back:', err && err.message || err); } catch (e) {}
    try { destroy(); } catch (e) {}
    onFail(err);
  }
  /* a handle that is already dead, for the capability failures found before anything is built: onFail('perf') fires
     on the next tick (after mount() has returned, so the host's handle variable is set) */
  function refuse(reason) {
    dead = true;
    setTimeout(() => { if (failed) return; failed = true; try { console.debug('[orbit] WebGL globe declined: ' + reason); } catch (e) {} onFail('perf'); }, 0);
    const nop = () => {};
    return { pause: nop, resume: nop, destroy: nop, setPointer: nop, setQuality: nop, setGeometry: nop, setReducedMotion: nop, render: nop, stats: () => ({ declined: reason }), get ready() { return false; }, readyPromise: Promise.resolve(false) };
  }

  /* --- context: created here (a refusal never reaches three.js's console.error). failIfMajorPerformanceCaveat refuses
     software GL where the browser knows it is slow; the renderer string catches the rest — both → onFail('perf') --- */
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block';
  const attrs = { alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true };
  let ctx = null;
  try { ctx = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs); } catch (e) { ctx = null; }
  if (!ctx) return refuse('no hardware-accelerated WebGL context');
  const glName = rendererName(ctx);
  if (SOFT_GL.test(glName)) { try { const l = ctx.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); } catch (e) {} return refuse('software renderer (' + glName + ')'); }
  try { ctx.pixelStorei(ctx.UNPACK_COLORSPACE_CONVERSION_WEBGL, ctx.NONE); } catch (e) {}   // the maps are data: no colour management on upload
  container.appendChild(canvas);
  const renderer = new T.WebGLRenderer({ canvas, context: ctx, alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  const vtf = renderer.capabilities.vertexTextures;

  /* --- quality: everyone starts on the tier's full setting; setQuality('low') (bloom off, pixel ratio 1, half the
     points) stays available to the host. The fps guard below fails to the poster instead of degrading --- */
  let quality = 'high';
  const pixelRatio = () => Math.min(window.devicePixelRatio || 1, quality === 'low' ? 1 : TIERS[tier].dpr);
  renderer.setPixelRatio(pixelRatio());

  /* --- scene --- */
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(40, 1, CFG.D - 2.6, CFG.D + 3.0);
  camera.position.set(0, 0, CFG.D); camera.lookAt(0, 0, 0);
  const tiltG = new T.Group(); tiltG.rotation.set(view.tiltX, 0, view.tiltZ); scene.add(tiltG);
  const spinG = new T.Group(); tiltG.add(spinG);
  let spin = (-90 - view.lon0) * DEG; spinG.rotation.y = spin;
  const KEY = new T.Vector3(-0.66, 0.70, 0.27).normalize();   // upper left, grazing: plate interiors sit in half light, the lower right goes dark
  const RIM = new T.Vector3(0.55, -0.45, -0.35).normalize();
  const uTime = { value: 0 }, uViewport = { value: new T.Vector2(2, 2) }, uCenterZ = { value: -CFG.D };
  const uTwinkle = { value: RM ? 0 : 1 }, uDots = { value: 360 }, uLimb = { value: new T.Vector2(CFG.lightLimb[0], CFG.lightLimb[1]) };
  const uKey = { value: KEY }, uDayNight = { value: CFG.dayNight }, uNight = { value: CFG.night }, uMinPx = { value: 1 };
  const uIntro = { value: 1 };            // the arcs/flashes/specks fade-in (CFG.intro), set every frame

  let geo = opts.geometry || null, sizeScale = 1, pr = pixelRatio();
  let composer = null, bloom = null, sphereMat = null, sphere = null;
  const texs = { coast: null, fields: null, color: null }, stubs = [];
  const pts = { lights: null, cores: null, city: null }, nPts = { lights: 0, cores: 0, city: 0 };
  let speckGeo = null, nSpecks = 0;
  let arcWidth = null; const ringObjs = [];
  const sized = [];                       // [{ u: uniform, k }] → uSizeK = pr · (D−1) · sizeScale · k
  const sizeBase = () => pr * (CFG.D - 1) * sizeScale;
  function sizeU(k) { const u = { value: sizeBase() * k }; sized.push({ u, k }); return u; }   // born at its real size: a sprite never changes scale after its first frame
  let time = 0, frames = 0, jsAcc = 0, perfDone = false, fpsN = 0, fpsT = 0, jsAvg = 0, buildMs = 0;
  let px = 0, py = 0, pxT = 0, pyT = 0, texBytes = 0;

  /* context loss: preventDefault keeps the context restorable; the host shows its poster meanwhile and the scene comes
     back on webglcontextrestored (three.js re-creates its GL state; textures re-upload from their ImageBitmaps; the
     composer, torn down while the context is lost, is rebuilt on the next frame) */
  function onLost(e) {
    try { e.preventDefault(); } catch (_) {}
    if (dead || lost) return;
    lost = true; hadLoss = true; stopLoop();
    dropComposer();
    try { console.debug('[orbit] WebGL context lost — poster until it restores'); } catch (_) {}
    onLostCb();
  }
  function onRestored() {
    if (dead || !lost) return;
    lost = false;
    for (const k in texs) if (texs[k]) texs[k].needsUpdate = true;
    if (geo) setGeometry(geo);
    if (!ready) return;                                   // still building: ready announces itself when it gets there
    render(0, 0);
    try { console.debug('[orbit] WebGL context restored'); } catch (_) {}
    if (pendingReady) { pendingReady = false; onReady(); } else onRestoredCb();
    if (!external && !RM) startLoop();
  }
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  function applySizes() {
    const base = sizeBase();
    for (let i = 0; i < sized.length; i++) sized[i].u.value = base * sized[i].k;
  }
  function setGeometry(g) {
    if (!g || dead) return;
    geo = g;
    const nt = tierFor(viewW()); if (nt !== tier) { tier = nt; applyRanges(); }   // re-tier: pixel-ratio cap, point shares, arcs alive
    pr = pixelRatio();
    const W = Math.max(2, Math.round(g.W)), H = Math.max(2, Math.round(g.H));
    renderer.setPixelRatio(pr); renderer.setSize(W, H, false);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const tanA = 1 / Math.sqrt(CFG.D * CFG.D - 1);
    camera.fov = 2 * Math.atan(tanA * g.cy / g.R) / DEG;
    camera.setViewOffset(Math.max(2, 2 * g.cx), Math.max(2, 2 * g.cy), 0, 0, W, H);
    camera.updateProjectionMatrix();
    if (composer) { composer.setPixelRatio(pr); composer.setSize(W, H); }
    uViewport.value.set(W * pr, H * pr);
    sizeScale = g.R / 259;
    uMinPx.value = pr * CFG.minPx;
    /* dot density from the sphere's size: a cell every ~4.1 CSS px (≈ 400 around the equator at R = 259) */
    let dots = Math.round(TAU * g.R / CFG.cellPx); dots = clamp(dots, 220, CFG.dotsMax); dots -= dots % 2; uDots.value = dots;
    applySizes();
    if (arcWidth) arcWidth.value = CFG.arcs.width * pr;
    for (let i = 0; i < ringObjs.length; i++) ringObjs[i].widthU.value = 1.0 * pr;
    if (ready && (RM || paused)) render(0, 0);          // a resize clears the drawing buffer: never leave it empty when nothing else will redraw
  }
  if (geo) setGeometry(geo);
  function pointsMat(k) {
    return additive({ uniforms: { uSizeK: sizeU(k), uTime: uTime, uTwinkle: uTwinkle, uFade: { value: 1 }, uLimb: uLimb, uKey: uKey, uDayNight: uDayNight, uNight: uNight, uMinPx: uMinPx }, vertexShader: LIGHT_VS, fragmentShader: DOT_FS });
  }

  /* ------------------------------------------------------------ build */
  /* The data job (Worker: fetch, decode, light list, sphere mesh) runs while the main thread creates every material on
     stand-in data and compiles the programs, one per task; the data then only has to be uploaded, one texture per task. */
  async function build() {
    const T0 = performance.now(), ph = []; let tl = T0;
    const lap = name => { const now = performance.now(); ph.push(name + ' ' + Math.round(now - tl)); tl = now; };
    const abs = f => new URL(assetBase + f, document.baseURI).href;
    const dataP = runJob({ urls: { coast: abs(CFG.assets.coast), fields: abs(CFG.assets.fields[builtName]), color: abs(CFG.assets.color[builtName]), lights: abs(CFG.assets.lights[builtName]) }, segs: built.segs, plate: CFG.plate, rampT: RAMPT, ramp: RAMP });
    dataP.catch(() => {});
    await ensurePasses(assetBase);
    if (dead) return;
    await nextTick(); if (dead) return;             // mount() has returned with the context and renderer up: compiling starts in a task of its own
    /* materials on stand-ins, one program compiled per task: the sphere first (the largest), then the lights, arcs, flashes,
       rings, satellites, specks and halo (compileEach) */
    const stub = () => { const t = stubTexture(); stubs.push(t); return t; };
    const fieldsW = builtName === 'desktop' ? 2048 : 1024;
    sphereMat = new T.ShaderMaterial({
      uniforms: {
        uCoastMap: { value: stub() }, uFields: { value: stub() }, uColor: { value: stub() },
        uTexel: { value: new T.Vector2(1 / 2048, 1 / 1024) }, uTexelR: { value: new T.Vector2(1 / fieldsW, 2 / fieldsW) },
        uPlate: { value: vtf ? CFG.plate : 0 }, uRamp: { value: RAMPT },
        uBump: { value: CFG.bump }, uEdge: { value: CFG.edge }, uGlint: { value: CFG.glint }, uTopo: { value: CFG.topo * CFG.topoGain }, uHill: { value: new T.Vector3(CFG.hill, CFG.hillTilt, CFG.hillArid) }, uEdgeLit: { value: CFG.edgeLit }, uSheen: { value: CFG.sheen }, uWash: { value: CFG.wash },
        uGrey: { value: CFG.grey }, uGreyLo: { value: CFG.greyLo }, uGreyLift: { value: CFG.greyLift }, uKeyRim: { value: CFG.keyRim },
        uDots: uDots, uDotR: { value: CFG.dotR }, uOceanDot: { value: CFG.oceanDot }, uLandDot: { value: CFG.landDot }, uCoast: { value: CFG.coast },
        uLift: { value: CFG.lift }, uDesat: { value: CFG.desat },
        uShelf: { value: CFG.shelf }, uShallow: { value: CFG.shallow }, uGlintO: { value: CFG.glintO }, uGlintPow: { value: CFG.glintPow }, uAtmo: { value: CFG.atmo }, uAtmoLimb: { value: new T.Vector2(CFG.limb, CFG.limbPow) },
        uKey: uKey, uRim: { value: RIM }, uGlintL: { value: KEY.clone().lerp(new T.Vector3(0, 0, 1), clamp(CFG.glintDir, 0, 1)).normalize() }
      },
      vertexShader: SPHERE_VS, fragmentShader: SPHERE_FS, extensions: { derivatives: true }
    });
    const stubGeo = new T.BufferGeometry();
    stubGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(9), 3)); stubGeo.setAttribute('uv', new T.BufferAttribute(new Float32Array(6), 2));
    sphere = new T.Mesh(stubGeo, sphereMat); sphere.frustumCulled = false; spinG.add(sphere);
    renderer.compile(scene, camera);
    lap('sphere');
    await nextTick(); if (dead) return;
    for (const k of ['lights', 'cores', 'city']) {
      const p = new T.Points(pointGeometry(0), pointsMat(CFG.spriteK[k])); p.frustumCulled = false; spinG.add(p); pts[k] = p;
    }
    if (layers.arcs) buildArcs();
    if (layers.rings) buildRings(); if (layers.specks) buildSpecks(); buildHalo();
    await compileEach(); if (dead) return;
    lap('programs');
    if (quality === 'high') {                       // bloom: its programs one per task
      ensureComposer();
      await precompile(bloomMaterials()); if (dead) return;
      lap('bloom');
    }
    /* the data */
    const data = await dataP;
    if (dead) { for (const k of ['coast', 'fields', 'color']) if (data[k] && data[k].close) data[k].close(); return; }
    lap('data');
    for (const k of ['coast', 'fields', 'color']) {
      let im = data[k];
      if (!(im && typeof im.close === 'function')) im = await blobImage(im);   // no ImageBitmap in that context: decode here
      if (dead) return;
      const t = new T.Texture(im);
      t.flipY = false; t.premultiplyAlpha = false; t.generateMipmaps = true;
      t.wrapS = T.RepeatWrapping; t.wrapT = T.ClampToEdgeWrapping; t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter;
      t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy()); t.needsUpdate = true;
      renderer.initTexture(t);
      texs[k] = t; texBytes += Math.round(im.width * im.height * 4 * 1.34);
      await nextTick(); if (dead) return;
    }
    sphereMat.uniforms.uCoastMap.value = texs.coast; sphereMat.uniforms.uFields.value = texs.fields; sphereMat.uniforms.uColor.value = texs.color;
    const sg = new T.BufferGeometry();
    sg.setAttribute('position', new T.BufferAttribute(data.sphere.pos, 3)); sg.setAttribute('uv', new T.BufferAttribute(data.sphere.uv, 2));
    sg.setIndex(new T.BufferAttribute(data.sphere.idx, 1));
    sphere.geometry = sg; stubGeo.dispose();
    const names = ['lights', 'cores', 'city'];
    for (let i = 0; i < 3 && i < data.layers.length; i++) {
      const L = data.layers[i], p = pts[names[i]];
      p.geometry.dispose(); p.geometry = pointGeometry(L.n, L.pos, L.col, L.size, L.seed); nPts[names[i]] = L.n;
    }
    applyRanges();
    for (const t of stubs) t.dispose();
    lap('upload');
    await nextTick(); if (dead) return;
    render(0, 0);                                   // warm-up: geometry buffers, targets and every program exist before the crossfade
    lap('warm');
    ready = true;
    buildMs = Math.round(performance.now() - T0);
    mark('bmglobe:ready'); try { performance.measure('bmglobe:build', 'bmglobe:mount', 'bmglobe:ready'); } catch (e) {}
    try { console.debug('[orbit] globe v3 ready: tier ' + tier + ', ' + nPts.lights + ' lights, ' + nPts.cores + ' cores, ' + nPts.city + ' city points, quality ' + quality + ', dpr ' + pr + ', textures ' + (texBytes / 1048576).toFixed(1) + ' MB; build ' + buildMs + ' ms (' + ph.join(', ') + ')'); } catch (e) {}
    if (lost) pendingReady = true; else onReady();
    if (!external && !RM) startLoop();
  }
  function blobImage(b) {
    return new Promise((res, rej) => {
      if (!b || !window.URL) return rej(new Error('BMGlobe: no image data'));
      const u = URL.createObjectURL(b), im = new Image();
      im.onload = () => { const fin = () => { URL.revokeObjectURL(u); res(im); }; if (im.decode) im.decode().then(fin, fin); else fin(); };
      im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('BMGlobe: image decode failed')); };
      im.src = u;
    });
  }

  /* ------------------------------------------------------------- arcs */
  const MAXA = CFG.arcs.max, SEG = 48, PPA = (SEG + 1) * 2;      // vertices per arc (2 sides)
  const uHead = { value: new Float32Array(MAXA) }, uTail = { value: new Float32Array(MAXA) }, uGlow = { value: new Float32Array(MAXA) }, uPulse = { value: new Float32Array(MAXA).fill(-1) };
  const arcSlot = new Int16Array(MAXA).fill(-1), arcT0 = new Float32Array(MAXA), arcDur = new Float32Array(MAXA);
  let arcAlive = 0, arcNext = 0.4, arcPos = null, arcNxt = null, flashPos = null, cities = null, cityCum = null;
  const tmpA = [0, 0, 0], tmpB = [0, 0, 0], tmpQ = new T.Quaternion(), tmpV = new T.Vector3();
  /* endpoints: opts.cities ([name, lat, lon, pop, isUS]) when the host passes them, else METROS ([lat, lon, popK, isUS]);
     weight = (US ? 2 : 1) × max(0.6, log10(pop) − 5) */
  function prepCities() {
    const out = [];
    const host = Array.isArray(opts.cities) && opts.cities.length > 8;
    const list = host ? opts.cities : METROS;
    for (let i = 0; i < list.length; i++) {
      const c = list[i]; if (!c) continue;
      const la = host ? c[1] : c[0], lo = host ? c[2] : c[1], pop = host ? c[3] : c[2] * 1000, us = host ? c[4] : c[3];
      if (typeof la !== 'number' || typeof lo !== 'number') continue;
      const lat = la * DEG, phi = (lo + 180) * DEG, cl = Math.cos(lat);
      out.push({ x: -Math.cos(phi) * cl, y: Math.sin(lat), z: Math.sin(phi) * cl, lat: la, lon: lo, w: (us ? 2 : 1) * Math.max(0.6, Math.log10((pop || 1) + 1) - 5) });
    }
    out.sort((a, b) => b.w - a.w);
    cities = out.slice(0, 420);
    cityCum = new Float32Array(cities.length); let acc = 0;
    for (let i = 0; i < cities.length; i++) { acc += cities[i].w; cityCum[i] = acc; }
  }
  function pickCity() {
    const r = rnd() * cityCum[cityCum.length - 1]; let lo = 0, hi = cityCum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cityCum[mid] < r) lo = mid + 1; else hi = mid; }
    return cities[lo];
  }
  function frontFacing(c) {
    const lonF = -90 - spin / DEG; let dl = ((c.lon - lonF) % 360 + 540) % 360 - 180;
    return Math.abs(dl) < 75 && Math.abs(c.lat) < 62;
  }
  let arcGeom = null, flashGeom = null;
  function buildArcs() {
    prepCities();
    const n = MAXA * PPA;
    arcPos = new Float32Array(n * 3); arcNxt = new Float32Array(n * 3);
    const side = new Float32Array(n), aT = new Float32Array(n), aArc = new Float32Array(n), idx = new Uint16Array(MAXA * SEG * 6);
    for (let a = 0; a < MAXA; a++) for (let k = 0; k <= SEG; k++) for (let s = 0; s < 2; s++) { const j = a * PPA + k * 2 + s; side[j] = s ? 1 : -1; aT[j] = k / SEG; aArc[j] = a; }
    let q = 0;
    for (let a = 0; a < MAXA; a++) for (let k = 0; k < SEG; k++) { const a0 = a * PPA + k * 2, b0 = a0 + 2; idx[q++] = a0; idx[q++] = a0 + 1; idx[q++] = b0; idx[q++] = a0 + 1; idx[q++] = b0 + 1; idx[q++] = b0; }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(arcPos, 3)); g.setAttribute('aNext', new T.BufferAttribute(arcNxt, 3));
    g.setAttribute('aSide', new T.BufferAttribute(side, 1)); g.setAttribute('aT', new T.BufferAttribute(aT, 1)); g.setAttribute('aArc', new T.BufferAttribute(aArc, 1));
    g.setIndex(new T.BufferAttribute(idx, 1));
    const mat = ribbon({ defines: { MAXA }, uniforms: { uViewport, uWidth: { value: CFG.arcs.width * pr }, uHead, uTail, uGlow, uPulse, uColor: { value: new T.Color(CFG.orbit.arc) }, uHot: { value: new T.Color(CFG.orbit.arcHot) }, uAlpha: { value: CFG.arcs.alpha } }, vertexShader: ARC_VS, fragmentShader: ARC_FS });
    arcWidth = mat.uniforms.uWidth;
    const arcs = new T.Mesh(g, mat); arcs.frustumCulled = false; spinG.add(arcs);
    /* endpoint flashes */
    flashPos = new Float32Array(MAXA * 6);
    const fArc = new Float32Array(MAXA * 2), fEnd = new Float32Array(MAXA * 2);
    for (let a = 0; a < MAXA; a++) { fArc[a * 2] = a; fArc[a * 2 + 1] = a; fEnd[a * 2] = 0; fEnd[a * 2 + 1] = 1; }
    const fg = new T.BufferGeometry();
    fg.setAttribute('position', new T.BufferAttribute(flashPos, 3)); fg.setAttribute('aArc', new T.BufferAttribute(fArc, 1)); fg.setAttribute('aEnd', new T.BufferAttribute(fEnd, 1));
    const fc = CFG.orbit.flash;
    const fm = additive({ defines: { MAXA }, uniforms: { uHead, uTail, uGlow, uSizeK: sizeU(CFG.spriteK.flash), uFlash: { value: new T.Vector3(fc[0], fc[1], fc[2]) }, uMinPx: uMinPx }, vertexShader: FLASH_VS, fragmentShader: DOT_FS });
    const flashes = new T.Points(fg, fm); flashes.frustumCulled = false; spinG.add(flashes);
    arcGeom = g; flashGeom = fg;
  }
  function spawnArc(t) {
    if (!cities || cities.length < 2) return;
    let slot = -1; for (let i = 0; i < MAXA; i++) if (arcSlot[i] < 0) { slot = i; break; }
    if (slot < 0) return;
    /* the view line in the globe's own frame: an arc whose great circle contains it projects as a straight chord across the
       disc, so a pair is accepted only when its plane leans off that line by asin(minLean) or more. The globe turns while the
       arc lives (up to 63° over 14 s), so the test also runs against the view line at mid-life and at the end */
    const V = tmpV.set(0, 0, 1).applyQuaternion(spinG.getWorldQuaternion(tmpQ).invert());
    const dur = CFG.arcs.dur[0] + rnd() * (CFG.arcs.dur[1] - CFG.arcs.dur[0]);
    const dA = RM ? 0 : CFG.omega * dur, c1 = Math.cos(dA * 0.5), s1 = Math.sin(dA * 0.5), c2 = Math.cos(dA), s2 = Math.sin(dA);
    const Vmx = V.x * c1 - V.z * s1, Vmz = V.x * s1 + V.z * c1, Vex = V.x * c2 - V.z * s2, Vez = V.x * s2 + V.z * c2;
    let A = null, B = null;
    for (let tries = 0; tries < 40 && !B; tries++) {
      A = pickCity(); if (!frontFacing(A)) continue;
      for (let k = 0; k < 10; k++) {
        const c = pickCity(); if (c === A || !frontFacing(c)) continue;
        const dot = clamp(A.x * c.x + A.y * c.y + A.z * c.z, -1, 1), ang = Math.acos(dot) / DEG;
        if (ang < CFG.arcs.minDeg || ang > CFG.arcs.maxDeg) continue;
        const nx = A.y * c.z - A.z * c.y, ny = A.z * c.x - A.x * c.z, nz = A.x * c.y - A.y * c.x, nl = Math.hypot(nx, ny, nz) || 1e-6;
        const l0 = Math.abs(nx * V.x + ny * V.y + nz * V.z), l1 = Math.abs(nx * Vmx + ny * V.y + nz * Vmz), l2 = Math.abs(nx * Vex + ny * V.y + nz * Vez);
        if (Math.min(l0, l1, l2) / nl < CFG.arcs.minLean) continue;
        B = c; break;
      }
    }
    if (!B) return;
    const dot = clamp(A.x * B.x + A.y * B.y + A.z * B.z, -1, 1), om = Math.acos(dot), so = Math.sin(om) || 1e-6, lift = 0.10 + 0.26 * (om / PI);
    const base = slot * PPA * 3;
    function at(u, out) {
      const w1 = Math.sin((1 - u) * om) / so, w2 = Math.sin(u * om) / so, h = 1.004 + lift * Math.sin(PI * u);
      out[0] = (A.x * w1 + B.x * w2) * h; out[1] = (A.y * w1 + B.y * w2) * h; out[2] = (A.z * w1 + B.z * w2) * h;
    }
    for (let k = 0; k <= SEG; k++) {
      at(k / SEG, tmpA);
      if (k < SEG) at((k + 1) / SEG, tmpB); else { at((SEG - 1) / SEG, tmpB); tmpB[0] = 2 * tmpA[0] - tmpB[0]; tmpB[1] = 2 * tmpA[1] - tmpB[1]; tmpB[2] = 2 * tmpA[2] - tmpB[2]; }
      for (let s = 0; s < 2; s++) { const j = base + (k * 2 + s) * 3; arcPos[j] = tmpA[0]; arcPos[j + 1] = tmpA[1]; arcPos[j + 2] = tmpA[2]; arcNxt[j] = tmpB[0]; arcNxt[j + 1] = tmpB[1]; arcNxt[j + 2] = tmpB[2]; }
    }
    flashPos[slot * 6] = A.x * 1.008; flashPos[slot * 6 + 1] = A.y * 1.008; flashPos[slot * 6 + 2] = A.z * 1.008;
    flashPos[slot * 6 + 3] = B.x * 1.008; flashPos[slot * 6 + 4] = B.y * 1.008; flashPos[slot * 6 + 5] = B.z * 1.008;
    arcGeom.attributes.position.needsUpdate = true; arcGeom.attributes.aNext.needsUpdate = true; flashGeom.attributes.position.needsUpdate = true;
    arcSlot[slot] = 1; arcT0[slot] = t; arcDur[slot] = dur; arcAlive++;
  }
  /* lifecycle: grow from A for the first 18 %, hold (one bead travels A → B), retract from A over the last 22 % */
  function updateArcs(t) {
    if (!arcGeom) return;
    const head = uHead.value, tail = uTail.value, glow = uGlow.value, pulse = uPulse.value, target = TIERS[tier].arcs, intro = uIntro.value;
    for (let i = 0; i < MAXA; i++) {
      if (arcSlot[i] < 0) { glow[i] = 0; pulse[i] = -1; continue; }
      const age = t - arcT0[i], dur = arcDur[i];
      if (age >= dur) { arcSlot[i] = -1; arcAlive--; glow[i] = 0; pulse[i] = -1; continue; }
      const p = age / dur;
      head[i] = smooth(0, 1, clamp(p / 0.18, 0, 1)); tail[i] = smooth(0, 1, clamp((p - 0.78) / 0.22, 0, 1));
      glow[i] = Math.min(1, age / 0.6) * Math.min(1, (dur - age) / 0.8) * intro;   // the glow feeds both the ribbon and its endpoint flashes
      pulse[i] = (p > 0.24 && p < 0.78) ? (p - 0.24) / 0.54 : -1;
    }
    /* pacing: quick refills below 80 % of the tier target (a failed spawn retries sooner), ~0.7 s between spawns near it */
    if (t >= arcNext && arcAlive < target) { const n0 = arcAlive; spawnArc(t); arcNext = t + (arcAlive === n0 ? 0.12 : arcAlive < target * 0.8 ? 0.2 + rnd() * 0.4 : 0.35 + rnd() * 0.7); }
  }
  function seedArcs() { if (!arcGeom) return; const n = TIERS[tier].arcs; for (let i = 0; i < n; i++) spawnArc(-rnd() * 7); }

  /* ------------------------------------------------------------ rings */
  function buildRings() {
    const g = ringGeometry(360), ringG = new T.Group(); scene.add(ringG);
    for (let i = 0; i < CFG.rings.length; i++) {
      const R = CFG.rings[i], grp = new T.Group();
      grp.rotation.order = 'ZYX'; grp.rotation.set(R.rx * DEG, R.ry * DEG, R.rz * DEG); grp.scale.setScalar(R.r); ringG.add(grp);
      const mat = ribbon({ uniforms: { uViewport, uWidth: { value: 1.0 * pr }, uCenterZ, uColor: { value: new T.Color(CFG.orbit.ring) }, uBase: { value: R.base }, uComet: { value: R.comet }, uOffset: { value: 0 }, uDash: { value: R.dash }, uAlpha: { value: CFG.orbit.ringAlpha } }, vertexShader: RING_VS, fragmentShader: RING_FS });
      const mesh = new T.Mesh(g, mat); mesh.frustumCulled = false; grp.add(mesh);
      const ns = R.sats.length, a0 = new Float32Array(ns), sp = new Float32Array(ns), sz = new Float32Array(ns), pos = new Float32Array(ns * 3);
      for (let s = 0; s < ns; s++) { a0[s] = R.sats[s][0]; sp[s] = R.sats[s][1]; sz[s] = R.sats[s][2] * 1.6; }
      const sg = new T.BufferGeometry();
      sg.setAttribute('position', new T.BufferAttribute(pos, 3)); sg.setAttribute('aAng0', new T.BufferAttribute(a0, 1)); sg.setAttribute('aSpeed', new T.BufferAttribute(sp, 1)); sg.setAttribute('aSize', new T.BufferAttribute(sz, 1));
      const sm = additive({ uniforms: { uTime, uSizeK: sizeU(CFG.spriteK.sats), uMinPx: uMinPx }, vertexShader: SAT_VS, fragmentShader: DOT_FS });
      const sats = new T.Points(sg, sm); sats.frustumCulled = false; grp.add(sats);
      ringObjs.push({ mat, sat0: R.sats[0], widthU: mat.uniforms.uWidth });
    }
  }
  function updateRings(t) { for (let i = 0; i < ringObjs.length; i++) { const r = ringObjs[i]; r.mat.uniforms.uOffset.value = r.sat0[0] + t * r.sat0[1]; } }

  /* ----------------------------------------------------------- specks */
  function buildSpecks() {
    /* half in a shell around the sphere, half in the band below it; most are 1–3 px specks, ~14 % are 4–10 px bokeh,
       ~3 % are large very soft discs */
    const n = built.specks, pos = new Float32Array(n * 3), sz = new Float32Array(n), al = new Float32Array(n), ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let x, y, z;
      if (rnd() < 0.5) { const u = rnd() * 2 - 1, a = rnd() * TAU, r = 1.05 + rnd() * 1.15, s = Math.sqrt(1 - u * u); x = Math.cos(a) * s * r; y = u * r; z = Math.sin(a) * s * r; }
      else { x = (rnd() * 2 - 1) * 2.2; y = -0.4 - rnd() * 1.6; z = (rnd() * 2 - 1) * 1.0; if (x * x + y * y + z * z < 1.1) { y -= 1.0; } }
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      const kind = rnd(), soft = kind < 0.035, big = kind < 0.17;
      sz[i] = soft ? 11 + rnd() * 8 : big ? 4.5 + rnd() * 5.5 : 1.1 + rnd() * 2.4;
      al[i] = soft ? 0.10 + rnd() * 0.10 : big ? 0.26 + rnd() * 0.26 : 0.5 + rnd() * 0.5; ph[i] = rnd() * 100;
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('aSize', new T.BufferAttribute(sz, 1)); g.setAttribute('aAlpha', new T.BufferAttribute(al, 1)); g.setAttribute('aPhase', new T.BufferAttribute(ph, 1));
    const m = additive({ uniforms: { uTime, uSizeK: sizeU(CFG.spriteK.specks), uMinPx: uMinPx, uIntro }, vertexShader: SPECK_VS, fragmentShader: DOT_FS });
    const p = new T.Points(g, m); p.frustumCulled = false; scene.add(p);
    speckGeo = g; nSpecks = n;
  }
  function buildHalo() {
    const hd = CFG.atmo > 0.5 ? new T.Vector2(-0.69, 0.72) : new T.Vector2(0.7071, -0.7071);   // the halo leans toward the key light with the lit-limb atmosphere, toward the rim otherwise
    const m = additive({ uniforms: { uAlpha: { value: CFG.halo }, uDir: { value: hd } }, vertexShader: HALO_VS, fragmentShader: HALO_FS });
    const q = new T.Mesh(new T.PlaneGeometry(2.6, 2.6), m); scene.add(q);   // in the scene, not the tilt group: the quad always faces the camera, so front faces only (one pass)
  }

  /* compiles the scene's materials that have no program yet, object by object, yielding after each new program (several
     materials share one: the three light layers, the six rings, their satellites), so no task holds more than one compile */
  async function compileEach() {
    const objs = []; scene.traverse(o => { if (o.material) objs.push(o); });
    for (let i = 0; i < objs.length; i++) {
      const n = renderer.info.programs.length;
      renderer.compile(objs[i], camera);
      if (renderer.info.programs.length !== n) { await nextTick(); if (dead) return; }
    }
  }

  /* ----------------------------------------------------------- bloom */
  /* the pass materials, compiled one per task on a throwaway quad before the first composer frame (same program keys, so
     the pass reuses them) */
  function bloomMaterials() {
    if (!bloom) return [];
    const mats = [bloom.materialHighPassFilter].concat(bloom.separableBlurMaterials || [], [bloom.compositeMaterial, bloom.materialCopy]);
    if (bloom.basic && composer.renderTarget1) { bloom.basic.map = composer.renderTarget1.texture; mats.push(bloom.basic); }
    return mats.filter(Boolean);
  }
  async function precompile(mats) {
    const tmp = new T.Scene(), quad = new T.Mesh(new T.PlaneGeometry(2, 2));
    tmp.add(quad);
    for (let i = 0; i < mats.length; i++) {
      quad.material = mats[i];
      try { renderer.compile(tmp, camera); } catch (e) {}
      await nextTick(); if (dead) break;            // after the last one too: the first texture upload gets a task of its own
    }
    quad.geometry.dispose();
  }
  function ensureComposer() {
    if (composer || dead) return;
    const s = renderer.getSize(new T.Vector2());
    composer = new T.EffectComposer(renderer);
    composer.addPass(new T.RenderPass(scene, camera));
    bloom = new T.UnrealBloomPass(new T.Vector2(s.x * CFG.bloom.res, s.y * CFG.bloom.res), CFG.bloom.strength, CFG.bloom.radius, CFG.bloom.threshold);
    const bloomSize = bloom.setSize.bind(bloom);
    bloom.setSize = (w, h) => bloomSize(w / pr * CFG.bloom.res, h / pr * CFG.bloom.res);   // the composer passes device px
    for (let i = 0; i < bloom.separableBlurMaterials.length; i++) { const m = bloom.separableBlurMaterials[i]; m.fragmentShader = BLUR_ALPHA_FS; m.needsUpdate = true; }
    const mc = bloom.materialCopy; mc.blending = T.CustomBlending; mc.blendEquation = T.AddEquation; mc.blendSrc = T.OneFactor; mc.blendDst = T.OneFactor; mc.blendSrcAlpha = T.OneFactor; mc.blendDstAlpha = T.OneFactor; mc.needsUpdate = true;
    /* the pass copies the scene to the screen with an opaque MeshBasicMaterial; r147 forces alpha = 1 for opaque
       materials (#define OPAQUE), which would make the whole canvas opaque — this copy keeps the scene's alpha */
    bloom.basic.dispose();
    bloom.basic = new T.MeshBasicMaterial({ transparent: true, blending: T.NoBlending, depthTest: false, depthWrite: false, toneMapped: false });
    composer.addPass(bloom);
    composer.setPixelRatio(pr); composer.setSize(s.x, s.y);
  }
  /* frees the composer's targets, pass materials and the bloom mip chain (used on context loss, in the low tier and in destroy) */
  function dropComposer() {
    if (!composer) return;
    try { bloom.dispose(); composer.dispose(); } catch (_) {}
    composer = null; bloom = null;
  }

  /* ---------------------------------------------------------- render */
  function render(t, dt) {
    if (!sphereMat || !texs.coast) return;            // nothing to draw before the data is up (the warm-up frame inside build() is the first)
    if (paused || dead || failed || lost) return;
    const t0 = performance.now();
    if (!(dt >= 0)) dt = 1 / 60; if (dt > 0.1) dt = 0.1;
    if (time === 0 && arcAlive === 0) seedArcs();
    if (!RM) { time += dt; spin += CFG.omega * dt; spinG.rotation.y = spin; }
    uIntro.value = RM || !(CFG.intro > 0) ? 1 : smooth(0, CFG.intro, time);   // 0 on the first live frame (t = 0, like the poster), 1 after CFG.intro s
    const f = Math.min(1, dt * 4); px += (pxT - px) * f; py += (pyT - py) * f;
    tiltG.rotation.x = view.tiltX + py * CFG.parallax; tiltG.rotation.y = px * CFG.parallax;
    updateArcs(time); updateRings(time);
    uTime.value = time;
    if (quality === 'high') { ensureComposer(); composer.render(); } else renderer.render(scene, camera);
    const ms = performance.now() - t0;
    if (!ready) return;
    /* main-thread cost of this frame function, averaged over 120 frames after a 12-frame warm-up (stats().jsMsAvg) */
    if (!perfDone) { frames++; if (frames > 12) jsAcc += ms; if (frames === 132) { perfDone = true; jsAvg = jsAcc / 120; } }
    /* weak-GPU guard: once the host's crossfade is over (45 frames), the next 60 frames must average CFG.fpsMin; frames
       that span a pause (the host clamps those to 0.1 s) are not counted. Too slow → onFail('perf'): the poster stays */
    if (!RM && fpsN < 60 && frames > 45 && dt > 0 && dt < 0.0999) { fpsN++; fpsT += dt; if (fpsN === 60 && 60 / fpsT < CFG.fpsMin) { const fps = (60 / fpsT).toFixed(1); setTimeout(() => fail('perf'), 0); try { console.debug('[orbit] first 60 frames averaged ' + fps + ' fps'); } catch (e) {} } }
  }
  /* draw ranges: the point arrays are shuffled, so a prefix is a uniform subsample — the low tier halves everything, and a
     tier below the one built for (a desktop build shown at a tablet width) draws that tier's share of lights and specks */
  function applyRanges() {
    const q = quality === 'low' ? 0.5 : 1, cur = TIERS[tier];
    const fl = q * Math.min(1, cur.lights / built.lights), fs = q * Math.min(1, cur.specks / built.specks);
    for (const k of ['lights', 'cores', 'city']) if (pts[k] && nPts[k]) pts[k].geometry.setDrawRange(0, Math.round(nPts[k] * (k === 'city' ? q : fl)));
    if (speckGeo) speckGeo.setDrawRange(0, Math.round(nSpecks * fs));
  }
  function setQuality(q) {
    if ((q !== 'low' && q !== 'high') || q === quality || dead) return;
    quality = q; applyRanges();
    if (q === 'low') dropComposer();                          // the low tier renders without it: free the targets and bloom mips now (ensureComposer rebuilds on the first 'high' frame)
    if (geo) setGeometry(geo);                                // re-applies the pixel ratio and the ribbon widths
  }
  function setReducedMotion(v) {
    v = !!v; if (v === RM || dead) return;
    RM = v; uTwinkle.value = RM ? 0 : 1;
    if (RM) { stopLoop(); if (ready) render(0, 0); } else if (!external) startLoop();
  }

  /* --------------------------------------------- standalone loop + visibility */
  let raf = 0, lastNow = 0, visible = true, io = null;
  function loop(now) { raf = 0; if (paused || dead || !visible || document.hidden || RM) return; const dt = lastNow ? (now - lastNow) / 1000 : 1 / 60; lastNow = now; render(0, dt); raf = requestAnimationFrame(loop); }
  function startLoop() { if (raf || !ready || paused || dead || RM || external || !visible || document.hidden) return; lastNow = 0; raf = requestAnimationFrame(loop); }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  function onVis() { if (document.hidden) stopLoop(); else startLoop(); }
  if (!external) {
    document.addEventListener('visibilitychange', onVis);
    if ('IntersectionObserver' in window) { io = new IntersectionObserver(es => { visible = es[es.length - 1].isIntersecting; if (visible) startLoop(); else stopLoop(); }, { threshold: 0 }); io.observe(canvas); }
  }

  function destroy() {
    if (dead) return; dead = true; stopLoop();
    if (!external) document.removeEventListener('visibilitychange', onVis);
    if (io) io.disconnect();
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    try {
      /* per-object disposal, unless the context was lost once: three.js's pre-loss bookkeeping would then delete objects of
         the dead context ("delete: object does not belong to this context" warnings). Losing the context below frees
         every GPU resource at once either way */
      if (!hadLoss) {
        scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        for (const k in texs) if (texs[k]) texs[k].dispose();
        for (const t of stubs) t.dispose();
        dropComposer();
      }
      renderer.dispose();
      const lose = ctx.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();   // free GPU memory now, not at GC
    } catch (e) {}
    for (const k in texs) { const im = texs[k] && texs[k].image; if (im && im.close) im.close(); texs[k] = null; }
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  /* kick off: defaults when the host gives no geometry */
  if (!geo) { const W = container.clientWidth || 600, H = container.clientHeight || 400; setGeometry({ W, H, R: Math.min(W, H) * 0.3, cx: W / 2, cy: H / 2 }); }
  const readyP = build().then(() => ready, err => { fail(err); throw err; });
  readyP.catch(() => {});

  return {
    pause() { paused = true; stopLoop(); },
    resume() { paused = false; startLoop(); },
    destroy,
    setPointer(nx, ny) { pxT = clamp(nx || 0, -1, 1); pyT = clamp(ny || 0, -1, 1); },
    setQuality,
    setGeometry,
    setReducedMotion,
    render,
    stats() { return { tier, builtTier: builtName, renderer: glName, quality, pixelRatio: pr, dots: uDots.value, lights: nPts.lights, cores: nPts.cores, cityPoints: nPts.city, specks: nSpecks, arcsAlive: arcAlive, arcsVisible: arcsVisible(), buildMs, jsMsAvg: jsAvg, fpsAvg: fpsN ? fpsN / fpsT : 0, textureBytes: texBytes, lost }; },
    get ready() { return ready; },
    readyPromise: readyP
  };
  /* arcs currently drawn with a visible length (glow > 0.3 and more than 15 % of their length showing) */
  function arcsVisible() { let n = 0; for (let i = 0; i < MAXA; i++) if (arcSlot[i] >= 0 && uGlow.value[i] > 0.3 && uHead.value[i] - uTail.value[i] > 0.15) n++; return n; }
}

window.BMGlobe = { mount, CFG, TIERS, POSTER, version: '3.0.0' };
/* hosts that ran before this script mount on this event; hosts that run after it find window.BMGlobe */
try { window.dispatchEvent(new CustomEvent('bmglobe-ready')); } catch (e) {}
})();
