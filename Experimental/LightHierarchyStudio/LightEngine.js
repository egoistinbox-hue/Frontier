/*============================================================================================================================================
                                                               LIGHTENGINE.JS
============================================================================================================================================*/
// 🧩 Light-Merging Lab: 32 Raw Emitters, Direction-Aware Light BVH ("Nanite for Lights"), Baked Directional Light Grid, & Error-Guided Refinement

export const WORLD_HALF_EXTENT = 12.0; // World spans [-12, +12] in X and Z (24m x 24m)

//------------------------------------------------------------------------------------------------------------------------
//                                           SCENE OBSTACLES (3D CAR + SHADOW PILLARS)
//------------------------------------------------------------------------------------------------------------------------

export const SCENE_BOXES = [
  // Car body centered at (0, 0.55, -4.2), facing +Z toward the plaza
  { name: 'CarChassis', min: [-1.15, 0.16, -6.2], max: [1.15, 0.96, -2.2], color: [0.16, 0.18, 0.22], rough: 0.28 },
  { name: 'CarCabin',   min: [-0.95, 0.96, -5.5], max: [0.95, 1.52, -3.5], color: [0.11, 0.13, 0.17], rough: 0.18 },
  // Two shadow-splitting bollards right in front of the headlights so merged-vs-split shadows are unmistakable!
  { name: 'PillarLeft',  min: [-1.45, 0.0, 1.2],  max: [-0.95, 1.65, 1.7], color: [0.42, 0.44, 0.48], rough: 0.65 },
  { name: 'PillarRight', min: [ 0.95, 0.0, 1.2],  max: [ 1.45, 1.65, 1.7], color: [0.42, 0.44, 0.48], rough: 0.65 },
  // Center divider block between opposing neon signs
  { name: 'NeonDivider', min: [ 5.35, 0.0, -3.6], max: [ 5.65, 2.2, -0.4], color: [0.30, 0.32, 0.36], rough: 0.55 },
  // Lantern pedestal pillar
  { name: 'LanternPost', min: [-5.68, 0.0, -2.68], max: [-5.32, 1.55, -2.32], color: [0.34, 0.33, 0.30], rough: 0.72 },
];

//------------------------------------------------------------------------------------------------------------------------
//                                      32 RAW EMITTERS (HEADLIGHTS, 5-CLUSTER, OPPOSING NEON)
//------------------------------------------------------------------------------------------------------------------------

export function CreateSceneLights(timeSec = 0, animateRover = true) {
  const lights = [];
  let id = 0;

  // 1) CAR LEFT HEADLIGHT: 5 tightly packed warm-white forward spot LEDs at (-0.82, 0.64, -2.12) facing +Z
  const leftOffsets = [
    [0.0, 0.0, 0.0], [-0.11, 0.04, 0.0], [0.11, 0.04, 0.0], [-0.07, -0.05, 0.0], [0.07, -0.05, 0.0],
  ];
  for (let i = 0; i < leftOffsets.length; i++) {
    const o = leftOffsets[i];
    lights.push({
      id: id++,
      group: 'Headlights',
      subGroup: 'LeftHeadlight',
      pos: [-0.82 + o[0], 0.64 + o[1], -2.10 + o[2]],
      dir: [0.0, -0.10, 0.995],
      cosCone: 0.52, // Focused headlight beam
      color: [1.0, 0.94, 0.80],
      flux: 3.4, // 5 x 3.4 = 17.0 total flux in left headlight
    });
  }

  // 2) CAR RIGHT HEADLIGHT: 5 tightly packed warm-white forward spot LEDs at (+0.82, 0.64, -2.12) facing +Z
  for (let i = 0; i < leftOffsets.length; i++) {
    const o = leftOffsets[i];
    lights.push({
      id: id++,
      group: 'Headlights',
      subGroup: 'RightHeadlight',
      pos: [0.82 + o[0], 0.64 + o[1], -2.10 + o[2]],
      dir: [0.0, -0.10, 0.995],
      cosCone: 0.52,
      color: [1.0, 0.94, 0.80],
      flux: 3.4, // 5 x 3.4 = 17.0 total flux in right headlight
    });
  }

  // 3) 5-EMISSIVE CLUSTER AT 1 LOCATION: 5 amber lantern orbs clustered tightly at (-5.5, 1.95, -2.5)
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2.0;
    lights.push({
      id: id++,
      group: 'LanternCluster5',
      subGroup: 'LanternCluster5',
      pos: [-5.5 + Math.cos(ang) * 0.22, 1.95 + (i % 2) * 0.09, -2.5 + Math.sin(ang) * 0.22],
      dir: [0.0, -1.0, 0.0],
      cosCone: -1.0, // Omnidirectional
      color: [1.0, 0.66, 0.24],
      flux: 3.2, // 5 x 3.2 = 16.0 total flux
    });
  }

  // 4) OPPOSING NEON PAIR: 4 Magenta emitters facing -X vs 4 Cyan emitters facing +X across divider
  for (let i = 0; i < 4; i++) {
    const zOff = -3.1 + i * 0.72;
    lights.push({
      id: id++,
      group: 'OpposingNeon',
      subGroup: 'MagentaWest',
      pos: [5.15, 1.35, zOff],
      dir: [-0.95, -0.31, 0.0],
      cosCone: 0.15,
      color: [1.0, 0.20, 0.68],
      flux: 3.6,
    });
  }
  for (let i = 0; i < 4; i++) {
    const zOff = -3.1 + i * 0.72;
    lights.push({
      id: id++,
      group: 'OpposingNeon',
      subGroup: 'CyanEast',
      pos: [5.85, 1.35, zOff],
      dir: [0.95, -0.31, 0.0],
      cosCone: 0.15,
      color: [0.16, 0.88, 1.0],
      flux: 3.6,
    });
  }

  // 5) DISTANT PLAZA LAMPS (6 emitters at far corners — ideal candidates for distant LOD merging!)
  const plazaCoords = [
    [-7.8, 2.4, 5.8, [0.52, 0.92, 0.62]],
    [-7.4, 2.4, 6.2, [0.52, 0.92, 0.62]],
    [-7.6, 2.5, 5.5, [0.52, 0.92, 0.62]],
    [ 7.5, 2.4, 6.0, [0.98, 0.78, 0.48]],
    [ 7.9, 2.4, 5.6, [0.98, 0.78, 0.48]],
    [ 7.6, 2.5, 6.4, [0.98, 0.78, 0.48]],
  ];
  for (let i = 0; i < plazaCoords.length; i++) {
    const c = plazaCoords[i];
    lights.push({
      id: id++,
      group: i < 3 ? 'PlazaWest' : 'PlazaEast',
      subGroup: i < 3 ? 'PlazaWest' : 'PlazaEast',
      pos: [c[0], c[1], c[2]],
      dir: [0.0, -1.0, 0.0],
      cosCone: -1.0,
      color: c[3],
      flux: 3.0,
    });
  }

  // 6) DYNAMIC ORBITING EMISSIVE DRONE (3 tightly coupled emerald orbs)
  const t = animateRover ? timeSec * 0.55 : 0.7;
  const rx = Math.sin(t) * 4.4;
  const rz = 4.6 + Math.cos(t * 1.3) * 2.2;
  for (let i = 0; i < 3; i++) {
    const a = t * 2.5 + (i * Math.PI * 2) / 3;
    lights.push({
      id: id++,
      group: 'RoverCluster',
      subGroup: 'RoverCluster',
      pos: [rx + Math.cos(a) * 0.16, 1.25, rz + Math.sin(a) * 0.16],
      dir: [0.0, -1.0, 0.0],
      cosCone: -1.0,
      color: [0.28, 1.0, 0.58],
      flux: 3.1,
    });
  }

  return lights; // Exactly 32 lights!
}

//------------------------------------------------------------------------------------------------------------------------
//                                  ANALYTIC RAY-BOX SHADOW & PHYSICAL LIGHT EVALUATION
//------------------------------------------------------------------------------------------------------------------------

function RayIntersectsBox(ox, oy, oz, dx, dy, dz, maxT, box) {
  let tmin = 0.02;
  let tmax = maxT - 0.03;
  const dirs = [dx, dy, dz];
  const orig = [ox, oy, oz];
  for (let axis = 0; axis < 3; axis++) {
    const inv = Math.abs(dirs[axis]) > 1e-6 ? 1.0 / dirs[axis] : 1e9;
    let t0 = (box.min[axis] - orig[axis]) * inv;
    let t1 = (box.max[axis] - orig[axis]) * inv;
    if (inv < 0) { const tmp = t0; t0 = t1; t1 = tmp; }
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
    if (tmax < tmin) return false;
  }
  return true;
}

export function ComputeFloorVisibility(px, py, pz, lx, ly, lz) {
  const vx = lx - px, vy = ly - py, vz = lz - pz;
  const dist = Math.hypot(vx, vy, vz);
  if (dist < 1e-4) return 1.0;
  const invD = 1.0 / dist;
  const dx = vx * invD, dy = vy * invD, dz = vz * invD;
  for (let i = 0; i < SCENE_BOXES.length; i++) {
    if (RayIntersectsBox(px, py, pz, dx, dy, dz, dist, SCENE_BOXES[i])) return 0.0;
  }
  return 1.0;
}

/**
 * Evaluates a single physical light (raw emitter OR flux-conserving merged BVH cluster)
 * at floor point (px, 0.02, pz) with normal (0, 1, 0).
 */
export function EvaluateSingleLightAtFloor(px, pz, light, useShadows = true) {
  const py = 0.02;
  const lx = light.pos[0] - px;
  const ly = light.pos[1] - py;
  const lz = light.pos[2] - pz;
  const distSq = lx * lx + ly * ly + lz * lz + 0.35; // soft physical area-core epsilon
  const dist = Math.sqrt(distSq);
  const invD = 1.0 / dist;
  const wx = lx * invD, wy = ly * invD, wz = lz * invD;
  if (wy <= 0.0) return [0, 0, 0, 0, 0, 0];

  // Spot / emission cone falloff
  let spot = 1.0;
  if (light.cosCone > -0.95) {
    // Direction from light to receiver is (-wx, -wy, -wz)
    const cosAngle = -(wx * light.dir[0] + wy * light.dir[1] + wz * light.dir[2]);
    const edge0 = light.cosCone;
    const edge1 = Math.min(0.99, light.cosCone + 0.30);
    const t = Math.max(0.0, Math.min(1.0, (cosAngle - edge0) / Math.max(1e-4, edge1 - edge0)));
    spot = t * t * (3.0 - 2.0 * t);
    if (spot <= 1e-4) return [0, 0, 0, 0, 0, 0];
  }

  const vis = useShadows ? ComputeFloorVisibility(px, py, pz, light.pos[0], light.pos[1], light.pos[2]) : 1.0;
  if (vis <= 0.0) return [0, 0, 0, 0, 0, 0];

  const atten = (light.flux * wy * spot * vis) / (distSq * Math.PI);
  return [
    light.color[0] * atten,
    light.color[1] * atten,
    light.color[2] * atten,
    wx, wy, wz,
  ];
}

//------------------------------------------------------------------------------------------------------------------------
//                    1. NAIVE CENTROID MERGE (SHOWS THE EXACT "HEADLIGHT AVERAGE" ERROR!)
//------------------------------------------------------------------------------------------------------------------------

/**
 * Demonstrates NAIVE merging: collapses every group (including BOTH headlights together at the car center,
 * and both opposing neon sides together!) into 1 single averaged light source.
 */
export function BuildNaiveMergedLights(rawLights) {
  const byGroup = new Map();
  for (const l of rawLights) {
    if (!byGroup.has(l.group)) byGroup.set(l.group, []);
    byGroup.get(l.group).push(l);
  }
  const merged = [];
  let idx = 0;
  for (const [groupName, list] of byGroup.entries()) {
    let px = 0, py = 0, pz = 0;
    let dx = 0, dy = 0, dz = 0;
    let cr = 0, cg = 0, cb = 0;
    let fluxSum = 0;
    let minCos = 1.0;
    for (const l of list) {
      px += l.pos[0]; py += l.pos[1]; pz += l.pos[2];
      dx += l.dir[0]; dy += l.dir[1]; dz += l.dir[2];
      cr += l.color[0] * l.flux;
      cg += l.color[1] * l.flux;
      cb += l.color[2] * l.flux;
      fluxSum += l.flux;
      minCos = Math.min(minCos, l.cosCone);
    }
    const n = list.length;
    const dLen = Math.hypot(dx, dy, dz);
    // Notice: for OpposingNeon (-X and +X), dx cancels near 0! That's the exact direction-averaging bug!
    const dir = dLen > 0.05 ? [dx / dLen, dy / dLen, dz / dLen] : [0, -1, 0];
    const cosCone = dLen > 0.05 ? minCos : -1.0;
    merged.push({
      id: idx++,
      group: groupName,
      subGroup: groupName,
      memberCount: n,
      memberIds: list.map((x) => x.id),
      pos: [px / n, py / n, pz / n], // Naive unweighted center -> puts both headlights in center of car grille!
      dir,
      cosCone,
      color: [cr / fluxSum, cg / fluxSum, cb / fluxSum],
      flux: fluxSum,
      radius: ComputeClusterRadius(list, [px / n, py / n, pz / n]),
      isNaiveWarning: groupName === 'Headlights' || groupName === 'OpposingNeon',
    });
  }
  return merged;
}

function ComputeClusterRadius(list, center) {
  let maxR = 0.05;
  for (const l of list) {
    const d = Math.hypot(l.pos[0] - center[0], l.pos[1] - center[1], l.pos[2] - center[2]);
    if (d > maxR) maxR = d;
  }
  return maxR;
}

//------------------------------------------------------------------------------------------------------------------------
//                  2. DIRECTION-AWARE LIGHT BVH ("NANITE FOR LIGHTS" DISTANCE-ERROR HIERARCHY)
//------------------------------------------------------------------------------------------------------------------------

function CreateBvhNodeStats(list) {
  let fluxSum = 0;
  let px = 0, py = 0, pz = 0;
  let cr = 0, cg = 0, cb = 0;
  let dx = 0, dy = 0, dz = 0;
  let minCos = 1.0;

  for (const l of list) {
    fluxSum += l.flux;
    px += l.pos[0] * l.flux;
    py += l.pos[1] * l.flux;
    pz += l.pos[2] * l.flux;
    cr += l.color[0] * l.flux;
    cg += l.color[1] * l.flux;
    cb += l.color[2] * l.flux;
    dx += l.dir[0] * l.flux;
    dy += l.dir[1] * l.flux;
    dz += l.dir[2] * l.flux;
    minCos = Math.min(minCos, l.cosCone);
  }
  const invF = 1.0 / Math.max(1e-6, fluxSum);
  const pos = [px * invF, py * invF, pz * invF];
  const color = [cr * invF, cg * invF, cb * invF];
  const dLen = Math.hypot(dx, dy, dz);
  const dir = dLen > 1e-4 ? [dx / dLen, dy / dLen, dz / dLen] : [0, -1, 0];

  // Directional coherence in [0..1]: 1 = all lights point same way; 0 = opposing directions (forces split!)
  const dirCoherence = dLen * invF;
  const radius = ComputeClusterRadius(list, pos);
  const cosCone = dirCoherence > 0.72 ? minCos : -1.0;

  // Color variance: if red & cyan lights are in same node, colorSpread is high -> forces split!
  let colorSpread = 0;
  for (const l of list) {
    colorSpread = Math.max(
      colorSpread,
      Math.hypot(l.color[0] - color[0], l.color[1] - color[1], l.color[2] - color[2])
    );
  }

  return {
    pos,
    dir,
    cosCone,
    color,
    flux: fluxSum, // FLUX IS SUMMED, NEVER AVERAGED!
    radius,
    dirCoherence,
    colorSpread,
    memberCount: list.length,
    members: list,
  };
}

/**
 * Builds a true Bottom-Up Agglomerative Direction- & Color-Aware Light BVH (real Lightcuts / Nanite-for-Lights!).
 * Repeatedly merges the pair of clusters with lowest combined (spatial + directional + color) cost:
 *   1) Tight 5-bulb clusters (Left Headlight LEDs, Right Headlight LEDs, 5-Lantern Cluster) merge FIRST!
 *   2) Left Headlight + Right Headlight (1.64 m apart, same +Z beam) become siblings under 1 CarHeadlights parent!
 *   3) Opposing Magenta (-X) and Cyan (+X) neon stay separated by huge directional+color cost until upper tree!
 */
export function BuildLightBvh(rawLights) {
  let nextNodeId = 0;
  const active = rawLights.map((l) => ({
    id: nextNodeId++,
    depth: 0,
    ...CreateBvhNodeStats([l]),
    left: null,
    right: null,
  }));

  while (active.length > 1) {
    let bestI = 0, bestJ = 1;
    let bestCost = Infinity;
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        const dist = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
        const dirDot = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2];
        const dirPenalty = (1.0 - Math.max(-1.0, Math.min(1.0, dirDot))) * 3.5;
        const colDist = Math.hypot(a.color[0] - b.color[0], a.color[1] - b.color[1], a.color[2] - b.color[2]) * 3.0;
        const conePenalty = Math.abs(a.cosCone - b.cosCone) * 1.4;
        const combinedRad = Math.max(a.radius, b.radius) + dist * 0.5;
        const cost = combinedRad + dirPenalty + colDist + conePenalty;
        if (cost < bestCost) {
          bestCost = cost;
          bestI = i;
          bestJ = j;
        }
      }
    }
    const left = active[bestI];
    const right = active[bestJ];
    const combinedMembers = [...left.members, ...right.members];
    const parent = {
      id: nextNodeId++,
      depth: Math.max(left.depth, right.depth) + 1,
      ...CreateBvhNodeStats(combinedMembers),
      left,
      right,
    };
    active.splice(bestJ, 1);
    active.splice(bestI, 1);
    active.push(parent);
  }
  return active[0];
}

/**
 * Evaluates the Nanite-for-Lights LOD Cut for a given world receiver position (rx, ry, rz).
 * Splits any BVH cluster whose flux-weighted angular spread (radius / dist), directional incoherence, or color spread
 * exceeds `errorThreshold` — up to `maxActiveLights`.
 *
 * Notice what happens automatically:
 *   - 5 bulbs in Left Headlight (radius 0.12 m) merge into 1 Left Headlight almost everywhere!
 *   - Left & Right Headlights (1.64 m apart) STAY SPLIT up close, and MERGE INTO 1 CAR LIGHT far away!
 */
export function ComputeLightCutForReceiver(bvhRoot, rx, ry, rz, errorThreshold = 0.22, maxActiveLights = 12) {
  const cut = [];
  function scoreNode(n) {
    if (!n.left || !n.right) return 0.0;
    const dist = Math.max(0.5, Math.hypot(n.pos[0] - rx, n.pos[1] - ry, n.pos[2] - rz));
    const fluxScale = Math.sqrt(Math.max(1.0, n.flux) / 14.0);
    // Angular spread error: (radius / dist) * flux importance (exact Lightcuts / Nanite-for-Lights metric!)
    const angularErr = (n.radius / dist) * fluxScale;
    const dirErr = (1.0 - n.dirCoherence) * (2.6 / dist) * fluxScale;
    const colErr = n.colorSpread * (2.2 / dist) * fluxScale;
    return angularErr + dirErr + colErr;
  }

  // Priority-queue style greedy top-down refinement: always split the node with the BIGGEST error!
  const active = [{ node: bvhRoot, err: scoreNode(bvhRoot) }];
  while (active.length < maxActiveLights) {
    active.sort((a, b) => b.err - a.err);
    const top = active[0];
    if (!top || !top.node.left || top.err <= errorThreshold) break;
    active.shift();
    active.push({ node: top.node.left, err: scoreNode(top.node.left) });
    active.push({ node: top.node.right, err: scoreNode(top.node.right) });
  }

  for (const item of active) {
    cut.push({
      ...item.node,
      nodeError: item.err,
      lodLevel: item.node.memberCount === 1 ? 0 : item.node.radius < 0.45 ? 1 : 2,
    });
  }
  return cut;
}

//------------------------------------------------------------------------------------------------------------------------
//            3. BAKED DIRECTIONAL LIGHT GRID (SAMPLE 1 CELL = 1 VIRTUAL LIGHT + AMBIENT RESIDUAL + ERROR MAP)
//------------------------------------------------------------------------------------------------------------------------

/**
 * Bakes a 2D spatial Light Grid (`gridRes x gridRes`) over [-12,+12]^2.
 * Each cell bakes ALL 32 lights into:
 *   - Total RGB Irradiance L0 (conserves 100% of energy — NEVER cancels opposing lights to black!)
 *   - Flux-weighted Dominant Direction (dx, dy, dz) + Directionality r = |L1| / L0 in [0..1]
 *   - Exact Per-Cell Error compared against Ground Truth (multi-point stratified error inside the cell!)
 *   - Top High-Error Residual Light IDs (for Mode 4: Error-Guided Hybrid Refinement!)
 */
export function BakeDirectionalLightGrid(rawLights, gridRes = 16) {
  const cellSize = (WORLD_HALF_EXTENT * 2.0) / gridRes;
  const cells = new Array(gridRes * gridRes);
  // Packed Float32 textures for WebGL upload (gridRes x gridRes x 4)
  // texIrr: [L0.r, L0.g, L0.b, directionality]
  // texDir: [domDir.x, domDir.y, domDir.z, cellError]
  const texIrr = new Float32Array(gridRes * gridRes * 4);
  const texDir = new Float32Array(gridRes * gridRes * 4);

  let maxCellErr = 1e-4;
  let totalRmseAccum = 0;

  for (let gz = 0; gz < gridRes; gz++) {
    for (let gx = 0; gx < gridRes; gx++) {
      const cx = -WORLD_HALF_EXTENT + (gx + 0.5) * cellSize;
      const cz = -WORLD_HALF_EXTENT + (gz + 0.5) * cellSize;

      let sumR = 0, sumG = 0, sumB = 0;
      let vx = 0, vy = 0, vz = 0;
      let lumSum = 0;
      const perLightContrib = [];

      for (let i = 0; i < rawLights.length; i++) {
        const res = EvaluateSingleLightAtFloor(cx, cz, rawLights[i], true);
        const lum = res[0] * 0.2126 + res[1] * 0.7152 + res[2] * 0.0722;
        if (lum > 1e-5) {
          sumR += res[0]; sumG += res[1]; sumB += res[2];
          vx += res[3] * lum;
          vy += res[4] * lum;
          vz += res[5] * lum;
          lumSum += lum;
          perLightContrib.push({ id: i, lum, r: res[0], g: res[1], b: res[2], wx: res[3], wy: res[4], wz: res[5] });
        }
      }

      const vLen = Math.hypot(vx, vy, vz);
      const directionality = lumSum > 1e-5 ? Math.min(1.0, vLen / lumSum) : 0.0;
      const domDir = vLen > 1e-5 ? [vx / vLen, vy / vLen, vz / vLen] : [0, 1, 0];

      // Measure TRUE Error inside this cell by comparing 4 sub-cell corners against the single baked cell light!
      // Also captures directional multi-light cancellation error (1 - directionality) * lumSum (e.g. opposing neon / 2 headlights!)
      const subOff = cellSize * 0.34;
      const probes = [
        [cx - subOff, cz - subOff],
        [cx + subOff, cz - subOff],
        [cx - subOff, cz + subOff],
        [cx + subOff, cz + subOff],
      ];
      let subErrAccum = 0;
      for (const pr of probes) {
        let tr = 0, tg = 0, tb = 0;
        for (let i = 0; i < rawLights.length; i++) {
          const r2 = EvaluateSingleLightAtFloor(pr[0], pr[1], rawLights[i], true);
          tr += r2[0]; tg += r2[1]; tb += r2[2];
        }
        const dr = tr - sumR, dg = tg - sumG, db = tb - sumB;
        subErrAccum += Math.sqrt((dr * dr + dg * dg + db * db) / 3.0);
      }
      // Directional multi-lobe error: when 2 bright lights hit from different angles, 1 dominant vector misses the 2nd specular lobe!
      const dirMultiLobeError = (1.0 - directionality) * Math.min(2.5, lumSum) * 0.65;
      const cellErr = subErrAccum * 0.25 + dirMultiLobeError;
      if (cellErr > maxCellErr) maxCellErr = cellErr;
      totalRmseAccum += cellErr * cellErr;

      // Sort contributing lights by luminance so Error-Guided Hybrid knows which lights caused the error!
      perLightContrib.sort((a, b) => b.lum - a.lum);

      const idx = gz * gridRes + gx;
      cells[idx] = {
        gx, gz, cx, cz,
        irradiance: [sumR, sumG, sumB],
        domDir,
        directionality,
        cellError: cellErr,
        topLights: perLightContrib.slice(0, 4),
      };

      texIrr[idx * 4 + 0] = sumR;
      texIrr[idx * 4 + 1] = sumG;
      texIrr[idx * 4 + 2] = sumB;
      texIrr[idx * 4 + 3] = directionality;

      texDir[idx * 4 + 0] = domDir[0];
      texDir[idx * 4 + 1] = domDir[1];
      texDir[idx * 4 + 2] = domDir[2];
      texDir[idx * 4 + 3] = cellErr;
    }
  }

  return {
    gridRes,
    cellSize,
    cells,
    texIrr,
    texDir,
    maxCellErr,
    avgGridError: Math.sqrt(totalRmseAccum / (gridRes * gridRes)),
  };
}

//------------------------------------------------------------------------------------------------------------------------
//                      CPU GLOBAL ERROR BENCHMARK (TRUTH VS NAIVE / GRID / NANITE LOD / HYBRID)
//------------------------------------------------------------------------------------------------------------------------

/**
 * Evaluates quantitative error (RMSE, Max Error, PSNR dB, Avg Light Evals/Pixel) across a 24x24 floor grid
 * for ANY algorithm so the user sees exact real numbers AND can run iterative Error-Guided Refinement!
 */
export function EvaluateModeErrorStats(mode, rawLights, naiveLights, bvhRoot, bakedGrid, opts) {
  const samples = 20;
  const step = (WORLD_HALF_EXTENT * 2.0) / samples;
  let sqErrSum = 0;
  let maxErr = 0;
  let evalsSum = 0;
  const nTotal = samples * samples;

  for (let sz = 0; sz < samples; sz++) {
    for (let sx = 0; sx < samples; sx++) {
      const px = -WORLD_HALF_EXTENT + (sx + 0.5) * step;
      const pz = -WORLD_HALF_EXTENT + (sz + 0.5) * step;

      // 1) Ground Truth (All 32 lights)
      let tr = 0, tg = 0, tb = 0;
      for (let i = 0; i < rawLights.length; i++) {
        const res = EvaluateSingleLightAtFloor(px, pz, rawLights[i], true);
        tr += res[0]; tg += res[1]; tb += res[2];
      }

      // 2) Approximation
      let ar = 0, ag = 0, ab = 0;
      let evals = 0;

      if (mode === 'naive') {
        evals = naiveLights.length;
        for (let i = 0; i < naiveLights.length; i++) {
          const res = EvaluateSingleLightAtFloor(px, pz, naiveLights[i], true);
          ar += res[0]; ag += res[1]; ab += res[2];
        }
      } else if (mode === 'grid') {
        evals = 1;
        const gx = Math.min(bakedGrid.gridRes - 1, Math.max(0, Math.floor(((px + WORLD_HALF_EXTENT) / (2 * WORLD_HALF_EXTENT)) * bakedGrid.gridRes)));
        const gz = Math.min(bakedGrid.gridRes - 1, Math.max(0, Math.floor(((pz + WORLD_HALF_EXTENT) / (2 * WORLD_HALF_EXTENT)) * bakedGrid.gridRes)));
        const cell = bakedGrid.cells[gz * bakedGrid.gridRes + gx];
        ar = cell.irradiance[0]; ag = cell.irradiance[1]; ab = cell.irradiance[2];
      } else if (mode === 'nanite') {
        const cut = ComputeLightCutForReceiver(bvhRoot, px, 0.02, pz, opts.errorThreshold, opts.maxActiveLights);
        evals = cut.length;
        for (let i = 0; i < cut.length; i++) {
          const res = EvaluateSingleLightAtFloor(px, pz, cut[i], true);
          ar += res[0]; ag += res[1]; ab += res[2];
        }
      } else {
        // Hybrid Error-Guided: use 1 Grid Sample in low-error cells; split via Light BVH in high-error cells!
        const gx = Math.min(bakedGrid.gridRes - 1, Math.max(0, Math.floor(((px + WORLD_HALF_EXTENT) / (2 * WORLD_HALF_EXTENT)) * bakedGrid.gridRes)));
        const gz = Math.min(bakedGrid.gridRes - 1, Math.max(0, Math.floor(((pz + WORLD_HALF_EXTENT) / (2 * WORLD_HALF_EXTENT)) * bakedGrid.gridRes)));
        const cell = bakedGrid.cells[gz * bakedGrid.gridRes + gx];
        if (cell.cellError <= opts.hybridErrorGate) {
          evals = 1;
          ar = cell.irradiance[0]; ag = cell.irradiance[1]; ab = cell.irradiance[2];
        } else {
          const cut = ComputeLightCutForReceiver(bvhRoot, px, 0.02, pz, opts.errorThreshold * 0.72, opts.maxActiveLights);
          evals = cut.length + 1;
          for (let i = 0; i < cut.length; i++) {
            const res = EvaluateSingleLightAtFloor(px, pz, cut[i], true);
            ar += res[0]; ag += res[1]; ab += res[2];
          }
        }
      }

      // Tone-mapped perceptual error (ACES-like curve so error reflects visual perception)
      const tm = (v) => v / (1.0 + v);
      const dr = tm(tr) - tm(ar);
      const dg = tm(tg) - tm(ag);
      const db = tm(tb) - tm(ab);
      const err = Math.sqrt((dr * dr + dg * dg + db * db) / 3.0);
      sqErrSum += err * err;
      if (err > maxErr) maxErr = err;
      evalsSum += evals;
    }
  }

  const rmse = Math.sqrt(sqErrSum / nTotal);
  const psnr = rmse > 1e-6 ? 20.0 * Math.log10(1.0 / rmse) : 60.0;
  const avgEvals = evalsSum / nTotal;
  return {
    rmse,
    maxErr,
    psnr,
    avgEvals,
    speedup: rawLights.length / Math.max(1.0, avgEvals),
  };
}
