/*============================================================================================================================================
                                                        CLUSTERFRACTURESDF.JS
============================================================================================================================================*/
// 🧩 128-triangle LOD cluster partitioner, procedural bark/foliage/UV textures, trunk fracture splitter, and live wind-deformed SDF/GDF section

import { DisplacePointByUnifiedWind } from './UnifiedWindField.js';

export const MAX_TRIANGLES_PER_CLUSTER = 128;

function HashClusterRgb(clusterId) {
  // Deterministic perceptually separated HSV -> RGB for 128-tri cluster visualization
  const hue = (clusterId * 0.618033988749895) % 1.0;
  const sat = 0.68 + 0.22 * ((clusterId * 37) % 5) / 4.0;
  const val = 0.78 + 0.18 * ((clusterId * 17) % 3) / 2.0;
  const i = Math.floor(hue * 6.0);
  const f = hue * 6.0 - i;
  const p = val * (1.0 - sat);
  const q = val * (1.0 - f * sat);
  const t = val * (1.0 - (1.0 - f) * sat);
  switch (i % 6) {
    case 0: return [val, t, p];
    case 1: return [q, val, p];
    case 2: return [p, val, t];
    case 3: return [p, q, val];
    case 4: return [t, p, val];
    default: return [val, p, q];
  }
}

/**
 * Partitions an indexed surface into 128-triangle clusters matching Frontier's ClusterPyramid.h.
 * Emits non-indexed cluster-tagged vertex attributes so each 128-tri cluster renders cleanly in Cluster mode.
 */
export function BuildClusteredBuffers(surfaceData, clusterIdOffset = 0, includeTint = false) {
  const idx = surfaceData.indices;
  const triCount = Math.floor(idx.length / 3);
  const outVerts = triCount * 3;
  const pos = new Float32Array(outVerts * 3);
  const nrm = new Float32Array(outVerts * 3);
  const uv = new Float32Array(outVerts * 2);
  const wind = new Float32Array(outVerts * 4);
  const piv = new Float32Array(outVerts * 3);
  const col = new Float32Array(outVerts * 3);
  const tint = includeTint ? new Float32Array(outVerts) : null;

  const clusterCount = Math.ceil(triCount / MAX_TRIANGLES_PER_CLUSTER);
  const clusterSpheres = [];

  for (let c = 0; c < clusterCount; c++) {
    const startTri = c * MAX_TRIANGLES_PER_CLUSTER;
    const endTri = Math.min(triCount, startTri + MAX_TRIANGLES_PER_CLUSTER);
    const rgb = HashClusterRgb(clusterIdOffset + c);
    let cx = 0, cy = 0, cz = 0;
    let countV = 0;

    for (let t = startTri; t < endTri; t++) {
      for (let k = 0; k < 3; k++) {
        const srcV = idx[t * 3 + k];
        const dstV = t * 3 + k;
        const px = surfaceData.positions[srcV * 3];
        const py = surfaceData.positions[srcV * 3 + 1];
        const pz = surfaceData.positions[srcV * 3 + 2];
        pos[dstV * 3] = px;
        pos[dstV * 3 + 1] = py;
        pos[dstV * 3 + 2] = pz;
        cx += px; cy += py; cz += pz;
        countV++;

        nrm[dstV * 3] = surfaceData.normals[srcV * 3];
        nrm[dstV * 3 + 1] = surfaceData.normals[srcV * 3 + 1];
        nrm[dstV * 3 + 2] = surfaceData.normals[srcV * 3 + 2];

        uv[dstV * 2] = surfaceData.uvs[srcV * 2];
        uv[dstV * 2 + 1] = surfaceData.uvs[srcV * 2 + 1];

        wind[dstV * 4] = surfaceData.wind[srcV * 4];
        wind[dstV * 4 + 1] = surfaceData.wind[srcV * 4 + 1];
        wind[dstV * 4 + 2] = surfaceData.wind[srcV * 4 + 2];
        wind[dstV * 4 + 3] = surfaceData.wind[srcV * 4 + 3];

        piv[dstV * 3] = surfaceData.pivots[srcV * 3];
        piv[dstV * 3 + 1] = surfaceData.pivots[srcV * 3 + 1];
        piv[dstV * 3 + 2] = surfaceData.pivots[srcV * 3 + 2];

        col[dstV * 3] = rgb[0];
        col[dstV * 3 + 1] = rgb[1];
        col[dstV * 3 + 2] = rgb[2];

        if (includeTint && surfaceData.tintVar) {
          tint[dstV] = surfaceData.tintVar[srcV];
        }
      }
    }

    if (countV > 0) {
      cx /= countV; cy /= countV; cz /= countV;
      let maxR = 0.05;
      for (let t = startTri; t < endTri; t++) {
        for (let k = 0; k < 3; k++) {
          const dstV = t * 3 + k;
          const d = Math.hypot(pos[dstV * 3] - cx, pos[dstV * 3 + 1] - cy, pos[dstV * 3 + 2] - cz);
          if (d > maxR) maxR = d;
        }
      }
      clusterSpheres.push({ id: clusterIdOffset + c, center: [cx, cy, cz], radius: maxR, triangles: endTri - startTri });
    }
  }

  return { positions: pos, normals: nrm, uvs: uv, wind, pivots: piv, clusterColors: col, tint, clusterCount, clusterSpheres, triangleCount: triCount };
}

/**
 * Splits a botanical specimen into a rooted lower stump and a fractured upper crown piece
 * along a Voronoi-jagged horizontal break seam at normalized height `cutHeightNorm`.
 */
export function SplitSpecimenForFracture(clusteredBark, clusteredFoliage, specimenHeight, cutHeightNorm = 0.28) {
  const cutY = Math.max(0.4, Math.min(specimenHeight * 0.78, specimenHeight * cutHeightNorm));

  function jaggedThreshold(x, z) {
    const ang = Math.atan2(z, x);
    return cutY + Math.sin(ang * 5.0) * 0.14 + Math.cos(ang * 11.0 + 0.8) * 0.07;
  }

  function partitionSurface(src, includeTint) {
    const lower = { positions: [], normals: [], uvs: [], wind: [], pivots: [], clusterColors: [], tint: [] };
    const upper = { positions: [], normals: [], uvs: [], wind: [], pivots: [], clusterColors: [], tint: [] };
    const tris = src.triangleCount;
    for (let t = 0; t < tris; t++) {
      const i0 = t * 3;
      const avgX = (src.positions[i0 * 3] + src.positions[(i0 + 1) * 3] + src.positions[(i0 + 2) * 3]) / 3.0;
      const avgY = (src.positions[i0 * 3 + 1] + src.positions[(i0 + 1) * 3 + 1] + src.positions[(i0 + 2) * 3 + 1]) / 3.0;
      const avgZ = (src.positions[i0 * 3 + 2] + src.positions[(i0 + 1) * 3 + 2] + src.positions[(i0 + 2) * 3 + 2]) / 3.0;
      const dst = avgY >= jaggedThreshold(avgX, avgZ) ? upper : lower;
      for (let k = 0; k < 3; k++) {
        const v = i0 + k;
        dst.positions.push(src.positions[v * 3], src.positions[v * 3 + 1], src.positions[v * 3 + 2]);
        dst.normals.push(src.normals[v * 3], src.normals[v * 3 + 1], src.normals[v * 3 + 2]);
        dst.uvs.push(src.uvs[v * 2], src.uvs[v * 2 + 1]);
        dst.wind.push(src.wind[v * 4], src.wind[v * 4 + 1], src.wind[v * 4 + 2], src.wind[v * 4 + 3]);
        dst.pivots.push(src.pivots[v * 3], src.pivots[v * 3 + 1], src.pivots[v * 3 + 2]);
        dst.clusterColors.push(src.clusterColors[v * 3], src.clusterColors[v * 3 + 1], src.clusterColors[v * 3 + 2]);
        if (includeTint && src.tint) dst.tint.push(src.tint[v]);
      }
    }
    const finalize = (bag) => ({
      positions: new Float32Array(bag.positions),
      normals: new Float32Array(bag.normals),
      uvs: new Float32Array(bag.uvs),
      wind: new Float32Array(bag.wind),
      pivots: new Float32Array(bag.pivots),
      clusterColors: new Float32Array(bag.clusterColors),
      tint: includeTint ? new Float32Array(bag.tint) : null,
      triangleCount: bag.positions.length / 9,
    });
    return { lower: finalize(lower), upper: finalize(upper) };
  }

  return {
    cutY,
    bark: partitionSurface(clusteredBark, false),
    foliage: partitionSurface(clusteredFoliage, true),
  };
}

/**
 * Generates procedural tileable PBR Bark Albedo canvas (fissures, plates, birch lenticels, etc.)
 */
export function ConstructBarkTextureCanvas(visual) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = visual.bark;
  ctx.fillRect(0, 0, size, size);

  const isBirch = visual.bark.toLowerCase() === '#dedad2' || visual.bark.toLowerCase() === '#cfcac0';

  if (isBirch) {
    // Horizontal dark lenticels characteristic of Birch & Aspen
    for (let i = 0; i < 140; i++) {
      const x = (i * 73) % size;
      const y = (i * 41) % size;
      const w = 14 + (i * 19) % 38;
      const h = 1.5 + (i % 3);
      ctx.fillStyle = visual.barkDark;
      ctx.globalAlpha = 0.45 + (i % 5) * 0.1;
      ctx.fillRect(x, y, w, h);
    }
  } else {
    // Vertical fibrous bark furrows & ridges
    for (let i = 0; i < 180; i++) {
      const x = (i * 53) % size;
      const y = (i * 29) % size;
      const w = 2 + (i % 5);
      const h = 38 + (i * 17) % 90;
      ctx.fillStyle = i % 3 === 0 ? visual.barkDark : '#000000';
      ctx.globalAlpha = i % 3 === 0 ? 0.55 : 0.22;
      ctx.fillRect(x, y, w, h);
      if (y + h > size) ctx.fillRect(x, y - size, w, h);
    }
    for (let i = 0; i < 80; i++) {
      const x = (i * 67 + 11) % size;
      const y = (i * 43) % size;
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.08;
      ctx.fillRect(x, y, 2, 26 + (i % 34));
    }
  }
  ctx.globalAlpha = 1.0;
  return canvas;
}

/**
 * Generates a high-contrast UV Unwrap Verification Checker Canvas with explicit U/V axes
 */
export function ConstructUvCheckerCanvas() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cells = 8;
  const cell = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const even = (x + y) % 2 === 0;
      ctx.fillStyle = even ? '#262930' : '#4a5568';
      ctx.fillRect(x * cell, y * cell, cell, cell);
      if (x === 0 || y === 0) {
        ctx.fillStyle = x === 0 ? '#ffb454' : '#34c759';
        ctx.fillRect(x * cell + 2, y * cell + 2, cell - 4, 4);
      }
      ctx.fillStyle = even ? '#cbd5e1' : '#e2e8f0';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(`${x},${cells - 1 - y}`, x * cell + 5, y * cell + 20);
    }
  }
  return canvas;
}

/**
 * Generates procedural species-matched Foliage Spray Cutout Canvas (Broadleaf, Conifer, Willow, Succulent)
 */
export function ConstructLeafTextureCanvas(visual) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  const style = visual.leafStyle || 'broadleaf';

  function drawBlade(cx, cy, rx, ry, rot, fill) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(0, ry);
    ctx.bezierCurveTo(rx, ry * 0.35, rx * 0.85, -ry * 0.5, 0, -ry);
    ctx.bezierCurveTo(-rx * 0.85, -ry * 0.5, -rx, ry * 0.35, 0, ry);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, ry * 0.85);
    ctx.lineTo(0, -ry * 0.78);
    ctx.stroke();
    ctx.restore();
  }

  if (style === 'conifer') {
    // Needle spray fan
    ctx.strokeStyle = visual.bark;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(128, 244);
    ctx.lineTo(128, 28);
    ctx.stroke();
    for (let i = 0; i < 38; i++) {
      const y = 230 - i * 5.2;
      const spread = 24 + Math.sin((i / 38) * Math.PI) * 64;
      ctx.strokeStyle = i % 2 === 0 ? visual.leaf : visual.leafAlt;
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.moveTo(128, y);
      ctx.lineTo(128 - spread, y - 24);
      ctx.moveTo(128, y);
      ctx.lineTo(128 + spread, y - 24);
      ctx.stroke();
    }
  } else if (style === 'willow') {
    // Slender drooping willow / bamboo lanceolate cluster
    for (let i = 0; i < 9; i++) {
      const ang = (i - 4) * 0.19;
      drawBlade(128 + Math.sin(ang) * 44, 134 - Math.cos(ang) * 18, 12, 74, ang, i % 2 === 0 ? visual.leaf : visual.leafAlt);
    }
  } else {
    // Broadleaf multi-leaf botanical spray (5-7 overlapping leaves on a petiole)
    ctx.strokeStyle = visual.bark;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(128, 248);
    ctx.lineTo(128, 52);
    ctx.stroke();
    const blades = [
      [128, 64, 34, 52, 0, visual.leafAlt],
      [82, 108, 32, 48, -0.58, visual.leaf],
      [174, 108, 32, 48, 0.58, visual.leaf],
      [74, 166, 30, 44, -0.78, visual.leafAlt],
      [182, 166, 30, 44, 0.78, visual.leafAlt],
      [104, 198, 24, 36, -0.45, visual.leaf],
      [152, 198, 24, 36, 0.45, visual.leaf],
    ];
    for (const b of blades) {
      drawBlade(b[0], b[1], b[2], b[3], b[4], b[5]);
    }
  }
  return canvas;
}

//------------------------------------------------------------------------------------------------------------------------
//                                  LIVE WIND-DEFORMED ANALYTICAL SDF & GDF SECTION
//------------------------------------------------------------------------------------------------------------------------

function sdTaperedCapsule(px, py, pz, ax, ay, az, bx, by, bz, rA, rB) {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const baDot = bax * bax + bay * bay + baz * baz;
  const h = Math.max(0.0, Math.min(1.0, baDot > 1e-8 ? (pax * bax + pay * bay + paz * baz) / baDot : 0.0));
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  const dz = paz - baz * h;
  const r = rA + (rB - rA) * h;
  return Math.hypot(dx, dy, dz) - r;
}

function sminCubic(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0.0) / Math.max(1e-4, k);
  return Math.min(a, b) - h * h * h * k * (1.0 / 6.0);
}

const _pA = new Float32Array(3);
const _pB = new Float32Array(3);

/**
 * Evaluates all wind-deformed analytical SDF primitives (capsules + canopy spheres) at `timeSec`
 * using the exact same UnifiedWindField. Returns displaced primitives for BOTH 3D gizmos AND GDF slice.
 */
export function EvaluateWindDeformedSdfPrimitives(specimen, timeSec, wind) {
  const capsules = [];
  for (const cap of specimen.sdfCapsules) {
    DisplacePointByUnifiedWind(
      _pA, cap.a[0], cap.a[1], cap.a[2], 0, 0,
      cap.windA[0], cap.windA[1], cap.windA[2], cap.windA[3],
      cap.pivot[0], cap.pivot[1], cap.pivot[2], specimen.height, timeSec, wind
    );
    DisplacePointByUnifiedWind(
      _pB, cap.b[0], cap.b[1], cap.b[2], 0, 0,
      cap.windB[0], cap.windB[1], cap.windB[2], cap.windB[3],
      cap.pivot[0], cap.pivot[1], cap.pivot[2], specimen.height, timeSec, wind
    );
    capsules.push({
      ax: _pA[0], ay: _pA[1], az: _pA[2],
      bx: _pB[0], by: _pB[1], bz: _pB[2],
      rA: cap.rA, rB: cap.rB, level: cap.level,
    });
  }

  const lobes = [];
  for (const lb of specimen.sdfCanopyLobes) {
    DisplacePointByUnifiedWind(
      _pA, lb.center[0], lb.center[1], lb.center[2], 0, 0,
      lb.windAttr[0], lb.windAttr[1], lb.windAttr[2], lb.windAttr[3],
      lb.pivot[0], lb.pivot[1], lb.pivot[2], specimen.height, timeSec, wind
    );
    lobes.push({
      cx: _pA[0], cy: _pA[1], cz: _pA[2],
      r: lb.radius,
    });
  }
  return { capsules, lobes };
}

/**
 * Renders a live vertical XY cross-section of the Global Distance Field (GDF) showing
 * smooth-union analytical capsules + swaying canopy lobes composited with the ground plane.
 */
export function RenderGdfCrossSection(canvas, deformedSdf, specimenHeight, smoothK = 0.65) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const span = Math.max(6.0, specimenHeight * 1.25);
  const halfX = span * 0.55;
  const maxY = span * 1.08;

  for (let py = 0; py < h; py++) {
    const wy = (1.0 - py / (h - 1)) * maxY - 0.8;
    for (let px = 0; px < w; px++) {
      const wx = ((px / (w - 1)) * 2.0 - 1.0) * halfX;
      let dWood = 1e6;
      for (let i = 0; i < deformedSdf.capsules.length; i++) {
        const c = deformedSdf.capsules[i];
        const dc = sdTaperedCapsule(wx, wy, 0.0, c.ax, c.ay, c.az, c.bx, c.by, c.bz, c.rA, c.rB);
        if (dc < dWood) dWood = dc;
      }
      let dCanopy = 1e6;
      for (let i = 0; i < deformedSdf.lobes.length; i++) {
        const l = deformedSdf.lobes[i];
        const dl = Math.hypot(wx - l.cx, wy - l.cy, -l.cz) - l.r;
        dCanopy = i === 0 ? dl : sminCubic(dCanopy, dl, smoothK);
      }
      const dGround = wy;
      const dTree = sminCubic(dWood, dCanopy, 0.35);
      const d = Math.min(dGround, dTree);

      // Distance isoline shading (Inigo Quilez signed field visual encoding)
      const idx = (py * w + px) * 4;
      const inside = d < 0.0;
      const absD = Math.abs(d);
      const iso = 0.78 + 0.22 * Math.cos(absD * 9.0);
      const zeroLine = Math.exp(-absD * 14.0);
      let r, g, b;
      if (inside) {
        r = (232 * iso + 255 * zeroLine);
        g = (146 * iso + 255 * zeroLine);
        b = (68 * iso + 255 * zeroLine);
      } else {
        const fade = Math.exp(-absD * 0.22);
        r = (24 + 52 * fade) * iso + 230 * zeroLine;
        g = (44 + 128 * fade) * iso + 235 * zeroLine;
        b = (64 + 158 * fade) * iso + 245 * zeroLine;
      }
      data[idx] = Math.min(255, Math.max(0, r));
      data[idx + 1] = Math.min(255, Math.max(0, g));
      data[idx + 2] = Math.min(255, Math.max(0, b));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
