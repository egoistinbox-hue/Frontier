/*============================================================================================================================================
                                                              LIGHTRENDERER.JS
============================================================================================================================================*/
// 🧩 Synchronized WebGL 3D PBR + Shadow Renderer (Ground Truth 32 Lights | Merged/Grid/Nanite/Hybrid | Real-Time Pixel Error Heatmap) + 3D Debug HUD

import { SCENE_BOXES, WORLD_HALF_EXTENT } from './LightEngine.js';

const MAX_LIGHTS = 32;

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// Generates GLSL obstacle list directly from SCENE_BOXES so CPU baker & GPU ray-tracer match 100% identically!
function BuildGlslBoxesBlock() {
  let code = `const int NUM_BOXES = ${SCENE_BOXES.length};\n`;
  code += `void getBox(int i, out vec3 bMin, out vec3 bMax, out vec3 bCol, out float bRough) {\n`;
  for (let i = 0; i < SCENE_BOXES.length; i++) {
    const b = SCENE_BOXES[i];
    const kw = i === 0 ? 'if' : 'else if';
    code += `  ${kw} (i == ${i}) { bMin = vec3(${b.min.map((v) => v.toFixed(3)).join(',')}); bMax = vec3(${b.max.map((v) => v.toFixed(3)).join(',')}); bCol = vec3(${b.color.map((v) => v.toFixed(3)).join(',')}); bRough = ${b.rough.toFixed(3)}; }\n`;
  }
  code += `  else { bMin = vec3(0.0); bMax = vec3(0.0); bCol = vec3(0.5); bRough = 0.5; }\n}\n`;
  return code;
}

const FRAG_SRC = `
precision highp float;
const int MAX_LIGHTS = ${MAX_LIGHTS};
varying vec2 vUv;

uniform vec2  uResolution;
uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;

// Mode: 0 = Ground Truth, 1 = Naive Merge, 2 = Directional Light Grid (1 Sample/Cell),
//       3 = Nanite-for-Lights (Distance BVH), 4 = Error-Guided Hybrid (Grid + High-Error BVH),
//       5 = Live Per-Pixel Error Heatmap |Truth - SelectedApprox|
uniform int   uViewMode;
uniform int   uCompareTarget; // 1=naive, 2=grid, 3=nanite, 4=hybrid (used when uViewMode == 5)
uniform float uErrorGain;
uniform float uFloorRoughness;
uniform float uHybridErrorGate;
uniform float uGridRes;
uniform float uShowGridLines;
uniform float uShowHybridMask;

// Raw 32 Ground Truth lights
uniform int   uRawCount;
uniform vec4  uRawPosFlux[${MAX_LIGHTS}];   // xyz = pos, w = flux
uniform vec4  uRawDirCone[${MAX_LIGHTS}];   // xyz = dir, w = cosCone
uniform vec4  uRawColor[${MAX_LIGHTS}];     // rgb = color

// Active Merged / BVH Cut lights (up to 32)
uniform int   uApproxCount;
uniform vec4  uApproxPosFlux[${MAX_LIGHTS}];
uniform vec4  uApproxDirCone[${MAX_LIGHTS}];
uniform vec4  uApproxColor[${MAX_LIGHTS}];

// Baked Directional Light Grid textures (packed float/half or normalized RGBA)
uniform sampler2D uGridIrrTex; // rgb = L0 irradiance / 4.0, a = directionality r in [0..1]
uniform sampler2D uGridDirTex; // rgb = domDir * 0.5 + 0.5, a = cellError / 2.0
uniform float uIrrScale;
uniform float uErrScale;

${BuildGlslBoxesBlock()}

vec2 intersectBox(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax, out vec3 outN) {
  vec3 invD = 1.0 / max(abs(rd), vec3(1e-5)) * sign(rd + vec3(1e-9));
  vec3 t0s = (bMin - ro) * invD;
  vec3 t1s = (bMax - ro) * invD;
  vec3 tSm = min(t0s, t1s);
  vec3 tBg = max(t0s, t1s);
  float tNear = max(max(tSm.x, tSm.y), tSm.z);
  float tFar  = min(min(tBg.x, tBg.y), tBg.z);
  outN = vec3(0.0, 1.0, 0.0);
  if (tNear > tFar || tFar < 0.0) return vec2(-1.0);
  if (tSm.x > tSm.y && tSm.x > tSm.z) outN = vec3(-sign(rd.x), 0.0, 0.0);
  else if (tSm.y > tSm.z) outN = vec3(0.0, -sign(rd.y), 0.0);
  else outN = vec3(0.0, 0.0, -sign(rd.z));
  return vec2(tNear, tFar);
}

float shadowRay(vec3 p, vec3 lightPos) {
  vec3 toL = lightPos - p;
  float dist = length(toL);
  if (dist < 0.02) return 1.0;
  vec3 rd = toL / dist;
  vec3 ro = p + rd * 0.02;
  for (int i = 0; i < NUM_BOXES; i++) {
    vec3 bMin, bMax, bCol; float bR;
    getBox(i, bMin, bMax, bCol, bR);
    vec3 tmpN;
    vec2 hit = intersectBox(ro, rd, bMin, bMax, tmpN);
    if (hit.x > 0.0 && hit.x < dist - 0.04) return 0.0;
  }
  return 1.0;
}

vec3 evalPbrSingleLight(vec3 P, vec3 N, vec3 V, vec3 albedo, float rough, vec4 posFlux, vec4 dirCone, vec3 col) {
  vec3 toL = posFlux.xyz - P;
  float distSq = dot(toL, toL) + 0.35;
  float dist = sqrt(distSq);
  vec3 L = toL / dist;
  float ndl = max(dot(N, L), 0.0);
  if (ndl <= 0.0) return vec3(0.0);

  float spot = 1.0;
  if (dirCone.w > -0.95) {
    float cosAng = dot(-L, normalize(dirCone.xyz));
    spot = smoothstep(dirCone.w, min(0.99, dirCone.w + 0.30), cosAng);
    if (spot <= 0.001) return vec3(0.0);
  }

  float vis = shadowRay(P + N * 0.015, posFlux.xyz);
  if (vis <= 0.0) return vec3(0.0);

  // Physically based Diffuse + GGX Specular lobe so double headlights show 2 distinct specular streaks!
  vec3 H = normalize(L + V);
  float ndh = max(dot(N, H), 0.0);
  float ndv = max(dot(N, V), 0.05);
  float a = max(0.06, rough * rough);
  float a2 = a * a;
  float denom = ndh * ndh * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * denom * denom + 1e-5);
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  float spec = (D * F) / (4.0 * ndv * ndl + 0.15);

  float radiance = (posFlux.w * spot * vis) / (distSq * 3.14159265);
  return col * radiance * (albedo * ndl + vec3(spec * ndl * 0.85));
}

vec3 evalGroundTruth(vec3 P, vec3 N, vec3 V, vec3 albedo, float rough) {
  vec3 sum = albedo * vec3(0.018, 0.022, 0.030);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uRawCount) break;
    sum += evalPbrSingleLight(P, N, V, albedo, rough, uRawPosFlux[i], uRawDirCone[i], uRawColor[i].rgb);
  }
  return sum;
}

vec3 evalMergedArray(vec3 P, vec3 N, vec3 V, vec3 albedo, float rough) {
  vec3 sum = albedo * vec3(0.018, 0.022, 0.030);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uApproxCount) break;
    sum += evalPbrSingleLight(P, N, V, albedo, rough, uApproxPosFlux[i], uApproxDirCone[i], uApproxColor[i].rgb);
  }
  return sum;
}

// Mode 2: 1-Sample Baked Directional Light Grid (L0 Energy Conservation + Dominant Direction L1 + Ambient Residual)
vec3 evalBakedGrid(vec3 P, vec3 N, vec3 V, vec3 albedo, float rough, out float outCellErr) {
  vec2 guv = clamp((P.xz + vec2(${WORLD_HALF_EXTENT.toFixed(1)})) / ${(WORLD_HALF_EXTENT * 2.0).toFixed(1)}, 0.001, 0.999);
  vec4 irrSample = texture2D(uGridIrrTex, guv);
  vec4 dirSample = texture2D(uGridDirTex, guv);
  vec3 L0 = irrSample.rgb * uIrrScale;
  float dirStrength = irrSample.a; // r = |L1|/L0 in [0..1]
  vec3 domDir = normalize(dirSample.rgb * 2.0 - 1.0);
  outCellErr = dirSample.a * uErrScale;

  // Split conserved L0 energy into Directional Light (r * L0 along domDir) + Isotropic Residual ((1-r) * L0)
  // So opposing lights NEVER cancel to black — they preserve energy cleanly!
  float ndl = max(dot(N, domDir), 0.0);
  vec3 H = normalize(domDir + V);
  float ndh = max(dot(N, H), 0.0);
  float ndv = max(dot(N, V), 0.05);
  float a = max(0.08, rough * rough);
  float a2 = a * a;
  float denom = ndh * ndh * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * denom * denom + 1e-5);
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  float spec = (D * F) / (4.0 * ndv * max(ndl, 0.15) + 0.15);

  // Diffuse uses conserved L0 modulated by surface normal alignment with dominant direction
  float normalMod = mix(1.0, max(0.15, ndl / max(0.25, domDir.y)), dirStrength * 0.85);
  vec3 diffTerm = albedo * L0 * normalMod;
  vec3 specTerm = L0 * (dirStrength * spec * 0.72);
  return albedo * vec3(0.018, 0.022, 0.030) + diffTerm + specTerm;
}

vec3 evalByMode(int mode, vec3 P, vec3 N, vec3 V, vec3 albedo, float rough, out float hybridMask) {
  hybridMask = 0.0;
  if (mode == 0) return evalGroundTruth(P, N, V, albedo, rough);
  if (mode == 1 || mode == 3) return evalMergedArray(P, N, V, albedo, rough);
  float cellErr = 0.0;
  vec3 gridCol = evalBakedGrid(P, N, V, albedo, rough, cellErr);
  if (mode == 2) return gridCol;
  // Mode 4: Error-Guided Hybrid! Low-error cells use 1 Grid Sample; high-error cells promote BVH split!
  float wSplit = smoothstep(uHybridErrorGate * 0.75, uHybridErrorGate * 1.35, cellErr);
  hybridMask = wSplit;
  if (wSplit <= 0.005) return gridCol;
  vec3 bvhCol = evalMergedArray(P, N, V, albedo, rough);
  return mix(gridCol, bvhCol, wSplit);
}

vec3 toneMap(vec3 c) {
  c = c / (vec3(1.0) + c);
  return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
}

// High-contrast Inferno Heatmap for pixel error visualization
vec3 infernoPalette(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.03, 0.03, 0.07);
  vec3 c1 = vec3(0.36, 0.07, 0.43);
  vec3 c2 = vec3(0.84, 0.28, 0.15);
  vec3 c3 = vec3(0.99, 0.88, 0.25);
  if (t < 0.33) return mix(c0, c1, t / 0.33);
  if (t < 0.66) return mix(c1, c2, (t - 0.33) / 0.33);
  return mix(c2, c3, (t - 0.66) / 0.34);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  float aspect = uResolution.x / max(1.0, uResolution.y);
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * aspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));
  vec3 ro = uCamPos;

  // Intersect Floor (y = 0) + 3D Scene Boxes
  float bestT = 1e6;
  vec3 hitN = vec3(0.0, 1.0, 0.0);
  vec3 hitCol = vec3(0.35);
  float hitRough = uFloorRoughness;
  bool hitFloor = false;

  if (rd.y < -1e-4) {
    float tf = -ro.y / rd.y;
    if (tf > 0.0 && tf < 180.0) {
      vec3 fp = ro + rd * tf;
      if (abs(fp.x) <= ${WORLD_HALF_EXTENT.toFixed(1)} && abs(fp.z) <= ${WORLD_HALF_EXTENT.toFixed(1)}) {
        bestT = tf;
        hitFloor = true;
        // Subtle architectural tile checkerboard (alternating matte & glossy tiles to expose specular error!)
        vec2 tile = floor(fp.xz * 0.5);
        float chk = mod(tile.x + tile.y, 2.0);
        hitCol = mix(vec3(0.24, 0.26, 0.29), vec3(0.32, 0.34, 0.38), chk);
        hitRough = clamp(uFloorRoughness + (chk - 0.5) * 0.14, 0.08, 0.95);
      }
    }
  }

  for (int i = 0; i < NUM_BOXES; i++) {
    vec3 bMin, bMax, bCol; float bR;
    getBox(i, bMin, bMax, bCol, bR);
    vec3 bn;
    vec2 h = intersectBox(ro, rd, bMin, bMax, bn);
    if (h.x > 0.0 && h.x < bestT) {
      bestT = h.x;
      hitN = bn;
      hitCol = bCol;
      hitRough = bR;
      hitFloor = false;
    }
  }

  if (bestT > 1e5) {
    // Deep studio horizon gradient
    float h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(mix(vec3(0.04, 0.05, 0.07), vec3(0.08, 0.10, 0.14), h), 1.0);
    return;
  }

  vec3 P = ro + rd * bestT;
  vec3 V = -rd;
  vec3 outRgb;

  if (uViewMode == 5) {
    // Live Exact Per-Pixel Error Heatmap: |ToneMap(GroundTruth) - ToneMap(Approx)| * Gain
    float dummyMask = 0.0;
    vec3 truth = toneMap(evalGroundTruth(P, hitN, V, hitCol, hitRough));
    vec3 approx = toneMap(evalByMode(uCompareTarget, P, hitN, V, hitCol, hitRough, dummyMask));
    float err = length(truth - approx) * 0.57735;
    outRgb = infernoPalette(err * uErrorGain);
  } else {
    float hybridMask = 0.0;
    vec3 hdr = evalByMode(uViewMode, P, hitN, V, hitCol, hitRough, hybridMask);
    outRgb = toneMap(hdr);
    if (uShowHybridMask > 0.5 && uViewMode == 4) {
      // Subtle tint showing where Hybrid uses 1 Grid Sample (teal) vs Error-Split BVH (amber)
      outRgb = mix(outRgb, mix(vec3(0.18, 0.72, 0.62), vec3(1.0, 0.58, 0.20), hybridMask), 0.22);
    }
  }

  // Crisp subtle floor grid lines when Show Grid is enabled
  if (hitFloor && uShowGridLines > 0.5) {
    vec2 cellUv = fract((P.xz + vec2(${WORLD_HALF_EXTENT.toFixed(1)})) / ${(WORLD_HALF_EXTENT * 2.0).toFixed(1)} * uGridRes);
    float edge = min(min(cellUv.x, 1.0 - cellUv.x), min(cellUv.y, 1.0 - cellUv.y));
    float line = 1.0 - smoothstep(0.0, 0.045, edge);
    outRgb = mix(outRgb, vec3(0.45, 0.85, 0.95), line * 0.34);
  }

  gl_FragColor = vec4(outRgb, 1.0);
}
`;

export class LightViewportRenderer {
  constructor(glCanvas, overlayCanvas) {
    this.glCanvas = glCanvas;
    this.overlayCanvas = overlayCanvas;
    this.overlayCtx = overlayCanvas.getContext('2d');
    const gl = glCanvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL not available');
    this.gl = gl;

    const vs = this._compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = this._compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Shader link failed: ' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    gl.useProgram(prog);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.loc = {};
    const names = [
      'uResolution', 'uCamPos', 'uCamRight', 'uCamUp', 'uCamFwd', 'uTanHalfFov',
      'uViewMode', 'uCompareTarget', 'uErrorGain', 'uFloorRoughness', 'uHybridErrorGate',
      'uGridRes', 'uShowGridLines', 'uShowHybridMask',
      'uRawCount', 'uRawPosFlux', 'uRawDirCone', 'uRawColor',
      'uApproxCount', 'uApproxPosFlux', 'uApproxDirCone', 'uApproxColor',
      'uGridIrrTex', 'uGridDirTex', 'uIrrScale', 'uErrScale',
    ];
    for (const n of names) this.loc[n] = gl.getUniformLocation(prog, n);

    this.gridIrrTex = this._createGridTexture(0);
    this.gridDirTex = this._createGridTexture(1);
    this.irrScale = 4.0;
    this.errScale = 2.0;

    // Reusable typed arrays for light uploads
    this._rawPos = new Float32Array(MAX_LIGHTS * 4);
    this._rawDir = new Float32Array(MAX_LIGHTS * 4);
    this._rawCol = new Float32Array(MAX_LIGHTS * 4);
    this._appPos = new Float32Array(MAX_LIGHTS * 4);
    this._appDir = new Float32Array(MAX_LIGHTS * 4);
    this._appCol = new Float32Array(MAX_LIGHTS * 4);
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile error: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  _createGridTexture(unit) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  uploadBakedGrid(bakedGrid) {
    const gl = this.gl;
    const res = bakedGrid.gridRes;
    const count = res * res;

    // Compute dynamic max scale for crisp 8-bit normalized texture precision (works universally on all WebGL1/2 GPUs!)
    let maxIrr = 0.5;
    let maxErr = 0.25;
    for (let i = 0; i < count; i++) {
      maxIrr = Math.max(maxIrr, bakedGrid.texIrr[i * 4], bakedGrid.texIrr[i * 4 + 1], bakedGrid.texIrr[i * 4 + 2]);
      maxErr = Math.max(maxErr, bakedGrid.texDir[i * 4 + 3]);
    }
    this.irrScale = maxIrr;
    this.errScale = maxErr;

    const bytesIrr = new Uint8Array(count * 4);
    const bytesDir = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      bytesIrr[i * 4 + 0] = Math.min(255, Math.round((bakedGrid.texIrr[i * 4 + 0] / maxIrr) * 255));
      bytesIrr[i * 4 + 1] = Math.min(255, Math.round((bakedGrid.texIrr[i * 4 + 1] / maxIrr) * 255));
      bytesIrr[i * 4 + 2] = Math.min(255, Math.round((bakedGrid.texIrr[i * 4 + 2] / maxIrr) * 255));
      bytesIrr[i * 4 + 3] = Math.min(255, Math.round(bakedGrid.texIrr[i * 4 + 3] * 255));

      bytesDir[i * 4 + 0] = Math.min(255, Math.max(0, Math.round((bakedGrid.texDir[i * 4 + 0] * 0.5 + 0.5) * 255)));
      bytesDir[i * 4 + 1] = Math.min(255, Math.max(0, Math.round((bakedGrid.texDir[i * 4 + 1] * 0.5 + 0.5) * 255)));
      bytesDir[i * 4 + 2] = Math.min(255, Math.max(0, Math.round((bakedGrid.texDir[i * 4 + 2] * 0.5 + 0.5) * 255)));
      bytesDir[i * 4 + 3] = Math.min(255, Math.round((bakedGrid.texDir[i * 4 + 3] / maxErr) * 255));
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.gridIrrTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, res, res, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytesIrr);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gridDirTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, res, res, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytesDir);
  }

  resize() {
    const rect = this.glCanvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(2, Math.floor(rect.width * dpr));
    const h = Math.max(2, Math.floor(rect.height * dpr));
    if (this.glCanvas.width !== w || this.glCanvas.height !== h) {
      this.glCanvas.width = w;
      this.glCanvas.height = h;
      this.overlayCanvas.width = Math.max(2, Math.floor(rect.width));
      this.overlayCanvas.height = Math.max(2, Math.floor(rect.height));
    }
    this.gl.viewport(0, 0, w, h);
  }

  render(cam, rawLights, approxLights, params) {
    const gl = this.gl;
    this.resize();
    gl.useProgram(this.prog);

    const pack = (list, posArr, dirArr, colArr) => {
      const n = Math.min(MAX_LIGHTS, list.length);
      for (let i = 0; i < n; i++) {
        const l = list[i];
        posArr[i * 4 + 0] = l.pos[0]; posArr[i * 4 + 1] = l.pos[1]; posArr[i * 4 + 2] = l.pos[2]; posArr[i * 4 + 3] = l.flux;
        dirArr[i * 4 + 0] = l.dir[0]; dirArr[i * 4 + 1] = l.dir[1]; dirArr[i * 4 + 2] = l.dir[2]; dirArr[i * 4 + 3] = l.cosCone;
        colArr[i * 4 + 0] = l.color[0]; colArr[i * 4 + 1] = l.color[1]; colArr[i * 4 + 2] = l.color[2]; colArr[i * 4 + 3] = 1.0;
      }
      return n;
    };

    const rawN = pack(rawLights, this._rawPos, this._rawDir, this._rawCol);
    const appN = pack(approxLights, this._appPos, this._appDir, this._appCol);

    gl.uniform2f(this.loc.uResolution, this.glCanvas.width, this.glCanvas.height);
    gl.uniform3fv(this.loc.uCamPos, cam.pos);
    gl.uniform3fv(this.loc.uCamRight, cam.right);
    gl.uniform3fv(this.loc.uCamUp, cam.up);
    gl.uniform3fv(this.loc.uCamFwd, cam.fwd);
    gl.uniform1f(this.loc.uTanHalfFov, cam.tanHalfFov);

    gl.uniform1i(this.loc.uViewMode, params.viewMode);
    gl.uniform1i(this.loc.uCompareTarget, params.compareTarget);
    gl.uniform1f(this.loc.uErrorGain, params.errorGain);
    gl.uniform1f(this.loc.uFloorRoughness, params.floorRoughness);
    gl.uniform1f(this.loc.uHybridErrorGate, params.hybridErrorGate);
    gl.uniform1f(this.loc.uGridRes, params.gridRes);
    gl.uniform1f(this.loc.uShowGridLines, params.showGrid ? 1.0 : 0.0);
    gl.uniform1f(this.loc.uShowHybridMask, params.showHybridMask ? 1.0 : 0.0);

    gl.uniform1i(this.loc.uRawCount, rawN);
    gl.uniform4fv(this.loc.uRawPosFlux, this._rawPos);
    gl.uniform4fv(this.loc.uRawDirCone, this._rawDir);
    gl.uniform4fv(this.loc.uRawColor, this._rawCol);

    gl.uniform1i(this.loc.uApproxCount, appN);
    gl.uniform4fv(this.loc.uApproxPosFlux, this._appPos);
    gl.uniform4fv(this.loc.uApproxDirCone, this._appDir);
    gl.uniform4fv(this.loc.uApproxColor, this._appCol);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.gridIrrTex);
    gl.uniform1i(this.loc.uGridIrrTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gridDirTex);
    gl.uniform1i(this.loc.uGridDirTex, 1);

    gl.uniform1f(this.loc.uIrrScale, this.irrScale);
    gl.uniform1f(this.loc.uErrScale, this.errScale);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Projects a 3D world point onto 2D overlay pixel coordinates matching the exact WebGL camera ray!
   */
  project(cam, wx, wy, wz) {
    const w = this.overlayCanvas.width;
    const h = this.overlayCanvas.height;
    const aspect = w / Math.max(1, h);
    const rx = wx - cam.pos[0], ry = wy - cam.pos[1], rz = wz - cam.pos[2];
    const z = rx * cam.fwd[0] + ry * cam.fwd[1] + rz * cam.fwd[2];
    if (z <= 0.1) return null;
    const x = rx * cam.right[0] + ry * cam.right[1] + rz * cam.right[2];
    const y = rx * cam.up[0] + ry * cam.up[1] + rz * cam.up[2];
    const ndcX = x / (z * aspect * cam.tanHalfFov);
    const ndcY = y / (z * cam.tanHalfFov);
    return [(ndcX * 0.5 + 0.5) * w, (1.0 - (ndcY * 0.5 + 0.5)) * h, z];
  }

  /**
   * Unprojects a 2D mouse click on the overlay canvas to the world floor plane (y = 0).
   */
  unprojectToFloor(cam, clientX, clientY) {
    const rect = this.overlayCanvas.getBoundingClientRect();
    const u = (clientX - rect.left) / Math.max(1, rect.width);
    const v = 1.0 - (clientY - rect.top) / Math.max(1, rect.height);
    const ndcX = u * 2.0 - 1.0;
    const ndcY = v * 2.0 - 1.0;
    const aspect = rect.width / Math.max(1, rect.height);
    const rdx = cam.fwd[0] + cam.right[0] * ndcX * aspect * cam.tanHalfFov + cam.up[0] * ndcY * cam.tanHalfFov;
    const rdy = cam.fwd[1] + cam.right[1] * ndcX * aspect * cam.tanHalfFov + cam.up[1] * ndcY * cam.tanHalfFov;
    const rdz = cam.fwd[2] + cam.right[2] * ndcX * aspect * cam.tanHalfFov + cam.up[2] * ndcY * cam.tanHalfFov;
    if (rdy >= -1e-4) return null;
    const t = -cam.pos[1] / rdy;
    const wx = cam.pos[0] + rdx * t;
    const wz = cam.pos[2] + rdz * t;
    if (Math.abs(wx) > WORLD_HALF_EXTENT || Math.abs(wz) > WORLD_HALF_EXTENT) return null;
    return [wx, wz];
  }

  /**
   * Draws crisp 3D-projected Light Debug Markers, Merge-Tree Links, Baked Directional Grid Arrows,
   * and the Interactive Receiver Probe directly over the WebGL viewport!
   */
  drawDebugOverlay(cam, opts) {
    const ctx = this.overlayCtx;
    const w = this.overlayCanvas.width;
    const h = this.overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    // 1) Visible Baked Directional Light Grid Arrows & Error Indicators
    if (opts.showGrid && opts.bakedGrid) {
      const g = opts.bakedGrid;
      const step = g.gridRes > 16 ? 2 : 1;
      for (let gz = 0; gz < g.gridRes; gz += step) {
        for (let gx = 0; gx < g.gridRes; gx += step) {
          const cell = g.cells[gz * g.gridRes + gx];
          const p0 = this.project(cam, cell.cx, 0.08, cell.cz);
          if (!p0) continue;
          const errNorm = Math.min(1.0, cell.cellError / Math.max(0.05, g.maxCellErr));
          const len = (0.35 + cell.directionality * 0.72) * (g.cellSize * 0.45);
          const p1 = this.project(
            cam,
            cell.cx + cell.domDir[0] * len,
            0.08 + cell.domDir[1] * len * 0.5,
            cell.cz + cell.domDir[2] * len
          );

          // Highlight high-error cells in coral/red, low-error cells in emerald/cyan
          const r = Math.round(70 + errNorm * 185);
          const gr = Math.round(215 - errNorm * 140);
          const b = Math.round(145 - errNorm * 95);
          ctx.strokeStyle = `rgba(${r},${gr},${b},0.78)`;
          ctx.fillStyle = `rgba(${r},${gr},${b},0.85)`;
          ctx.lineWidth = errNorm > 0.45 ? 1.7 : 1.1;

          if (p1) {
            ctx.beginPath();
            ctx.moveTo(p0[0], p0[1]);
            ctx.lineTo(p1[0], p1[1]);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(p1[0], p1[1], 2.0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    // 2) Light Debug Positions, Directions & Merge Tree Brackets
    if (opts.showLights) {
      if (opts.panelRole === 'truth') {
        // Show all 32 raw emitters + emission direction ticks
        for (const l of opts.rawLights) {
          const p = this.project(cam, l.pos[0], l.pos[1], l.pos[2]);
          if (!p) continue;
          const rgb = `rgb(${Math.round(l.color[0] * 255)},${Math.round(l.color[1] * 255)},${Math.round(l.color[2] * 255)})`;
          ctx.fillStyle = rgb;
          ctx.beginPath();
          ctx.arc(p[0], p[1], 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.75)';
          ctx.lineWidth = 1;
          ctx.stroke();

          if (l.cosCone > -0.9) {
            const pTip = this.project(cam, l.pos[0] + l.dir[0] * 1.1, l.pos[1] + l.dir[1] * 1.1, l.pos[2] + l.dir[2] * 1.1);
            if (pTip) {
              ctx.strokeStyle = rgb;
              ctx.globalAlpha = 0.6;
              ctx.beginPath();
              ctx.moveTo(p[0], p[1]);
              ctx.lineTo(pTip[0], pTip[1]);
              ctx.stroke();
              ctx.globalAlpha = 1.0;
            }
          }
        }
      } else if (opts.panelRole === 'approx') {
        // Show merged light nodes + dashed lines from each merged child emitter to its parent centroid!
        for (const node of opts.approxLights) {
          const pc = this.project(cam, node.pos[0], node.pos[1], node.pos[2]);
          if (!pc) continue;
          const isBadMerge = Boolean(node.isNaiveWarning);
          const strokeCol = isBadMerge ? '#ff5f56' : node.memberCount > 1 ? '#5bdb87' : '#ffb454';

          // Draw merge lines to member emitters
          const members = node.members || (node.memberIds ? node.memberIds.map((id) => opts.rawLights[id]).filter(Boolean) : []);
          if (members.length > 1) {
            ctx.save();
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = isBadMerge ? 'rgba(255,95,86,0.75)' : 'rgba(91,219,135,0.58)';
            ctx.lineWidth = 1.2;
            for (const m of members) {
              const pm = this.project(cam, m.pos[0], m.pos[1], m.pos[2]);
              if (!pm) continue;
              ctx.beginPath();
              ctx.moveTo(pm[0], pm[1]);
              ctx.lineTo(pc[0], pc[1]);
              ctx.stroke();
              ctx.fillStyle = 'rgba(255,255,255,0.45)';
              ctx.beginPath();
              ctx.arc(pm[0], pm[1], 2.0, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.restore();
          }

          // Merged node halo + core badge
          ctx.strokeStyle = strokeCol;
          ctx.lineWidth = 2.0;
          ctx.beginPath();
          ctx.arc(pc[0], pc[1], 6.5, 0, Math.PI * 2);
          ctx.stroke();

          ctx.fillStyle = `rgb(${Math.round(node.color[0] * 255)},${Math.round(node.color[1] * 255)},${Math.round(node.color[2] * 255)})`;
          ctx.beginPath();
          ctx.arc(pc[0], pc[1], 3.8, 0, Math.PI * 2);
          ctx.fill();

          // Explicit label showing merge count (e.g. "10→1 CENTER BAD!" or "5→1")
          if (node.memberCount > 1) {
            const label = isBadMerge ? `${node.memberCount}→1 MERGED @ CENTER!` : `${node.memberCount}→1`;
            ctx.font = '600 9.5px "DM Sans", sans-serif';
            const tw = ctx.measureText(label).width + 8;
            ctx.fillStyle = isBadMerge ? 'rgba(120,22,22,0.88)' : 'rgba(16,24,20,0.84)';
            ctx.fillRect(pc[0] - tw * 0.5, pc[1] - 22, tw, 14);
            ctx.fillStyle = isBadMerge ? '#ffb4ae' : '#8ef0b0';
            ctx.fillText(label, pc[0] - tw * 0.5 + 4, pc[1] - 12);
          }
        }
      }
    }

    // 3) Interactive Receiver Probe (shows live distance-LOD rays from clicked floor point!)
    if (opts.probePos) {
      const pp = this.project(cam, opts.probePos[0], 0.05, opts.probePos[1]);
      if (pp) {
        if (opts.panelRole === 'approx' && (opts.approxMode === 'nanite' || opts.approxMode === 'hybrid')) {
          ctx.strokeStyle = 'rgba(255,180,84,0.34)';
          ctx.lineWidth = 1.0;
          for (const node of opts.approxLights) {
            const pc = this.project(cam, node.pos[0], node.pos[1], node.pos[2]);
            if (!pc) continue;
            ctx.beginPath();
            ctx.moveTo(pp[0], pp[1]);
            ctx.lineTo(pc[0], pc[1]);
            ctx.stroke();
          }
        }
        ctx.strokeStyle = '#ffb454';
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.arc(pp[0], pp[1], 8.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#ffb454';
        ctx.beginPath();
        ctx.arc(pp[0], pp[1], 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '600 9.5px "DM Sans", sans-serif';
        ctx.fillStyle = '#ffd599';
        ctx.fillText(`PROBE (${opts.probePos[0].toFixed(1)}, ${opts.probePos[1].toFixed(1)})`, pp[0] + 11, pp[1] + 3);
      }
    }
  }
}
