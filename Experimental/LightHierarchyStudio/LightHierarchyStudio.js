/*============================================================================================================================================
                                                        LIGHTHIERARCHYSTUDIO.JS
============================================================================================================================================*/
// 🧩 Main interactive controller for the Light-Merging, Baked Directional Light Grid & Nanite-for-Lights Error Lab

import {
  CreateSceneLights,
  BuildNaiveMergedLights,
  BuildLightBvh,
  ComputeLightCutForReceiver,
  BakeDirectionalLightGrid,
  EvaluateModeErrorStats,
} from './LightEngine.js';
import { LightViewportRenderer } from './LightRenderer.js';

const MODE_META = {
  naive: {
    id: 1,
    title: 'Naive Centroid Merge (Averaged)',
    sub: 'Merges BOTH headlights at car center & mixes opposing neon -> BIG error!',
    dot: 'coral',
  },
  grid: {
    id: 2,
    title: 'Baked Directional Light Grid (1 Sample/Cell)',
    sub: 'Conserves L0 irradiance + Dominant L1 vector (never cancels to black!)',
    dot: 'amber',
  },
  nanite: {
    id: 3,
    title: 'Nanite-for-Lights (Distance Light BVH)',
    sub: 'Flux-summed hierarchy splits near/opposing lights & merges distant clusters',
    dot: 'green',
  },
  hybrid: {
    id: 4,
    title: 'Error-Guided Hybrid (Grid + High-Error Split)',
    sub: '1 Grid sample in low-error cells; automatic Light BVH split where error is big',
    dot: 'green',
  },
};

const state = {
  mode: 'naive', // Starts on Naive Merge so user immediately sees the BIG headlight error, then switches/refines!
  gridRes: 16,
  lodThreshold: 0.24,
  maxActiveLights: 12,
  hybridErrorGate: 0.18,
  errorGain: 4.5,
  floorRoughness: 0.28,
  showGrid: true,
  showLights: true,
  showHybridMask: false,
  animateDrone: true,
  probePos: [0.0, 2.2], // Positioned right in front of the 2 headlights & pillars!
  timeSec: 0,
  refineStep: 0,
  errorHistory: [],

  // Orbit Camera
  yaw: 0.42,
  pitch: 0.68,
  dist: 20.5,
  target: [0.0, 0.4, 0.2],
};

// Synchronized 3-Viewport WebGL Renderers
const vpTruth = new LightViewportRenderer(document.getElementById('CanvasTruth'), document.getElementById('OverlayTruth'));
const vpApprox = new LightViewportRenderer(document.getElementById('CanvasApprox'), document.getElementById('OverlayApprox'));
const vpError = new LightViewportRenderer(document.getElementById('CanvasError'), document.getElementById('OverlayError'));
const allViewports = [vpTruth, vpApprox, vpError];

let rawLights = [];
let naiveLights = [];
let bvhRoot = null;
let activeCut = [];
let bakedGrid = null;
let lastBakeTime = -10;
let lastStatsTime = -10;
let fpsSmooth = 60;
let lastFrameMs = performance.now();

function BuildCameraFrame() {
  const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
  const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
  const pos = [
    state.target[0] + sy * cp * state.dist,
    state.target[1] + sp * state.dist,
    state.target[2] + cy * cp * state.dist,
  ];
  const fwd = [state.target[0] - pos[0], state.target[1] - pos[1], state.target[2] - pos[2]];
  const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
  fwd[0] /= fl; fwd[1] /= fl; fwd[2] /= fl;

  // World up = (0, 1, 0), fallback to (0, 0, -1) for pure top-down view
  const upRef = Math.abs(fwd[1]) > 0.985 ? [0, 0, -1] : [0, 1, 0];
  const right = [
    fwd[1] * upRef[2] - fwd[2] * upRef[1],
    fwd[2] * upRef[0] - fwd[0] * upRef[2],
    fwd[0] * upRef[1] - fwd[1] * upRef[0],
  ];
  const rl = Math.hypot(right[0], right[1], right[2]) || 1;
  right[0] /= rl; right[1] /= rl; right[2] /= rl;

  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];

  return {
    pos: new Float32Array(pos),
    fwd: new Float32Array(fwd),
    right: new Float32Array(right),
    up: new Float32Array(up),
    tanHalfFov: Math.tan((44 * Math.PI) / 360),
  };
}

function RecomputeLightingData(forceBake = false) {
  rawLights = CreateSceneLights(state.timeSec, state.animateDrone);
  naiveLights = BuildNaiveMergedLights(rawLights);
  bvhRoot = BuildLightBvh(rawLights);
  activeCut = ComputeLightCutForReceiver(
    bvhRoot,
    state.probePos[0],
    0.1,
    state.probePos[1],
    state.lodThreshold,
    state.maxActiveLights
  );

  // Re-bake Directional Light Grid when resolution changes or every ~0.18s while drone animates
  if (forceBake || !bakedGrid || bakedGrid.gridRes !== state.gridRes || (state.animateDrone && state.timeSec - lastBakeTime > 0.18)) {
    bakedGrid = BakeDirectionalLightGrid(rawLights, state.gridRes);
    for (const vp of allViewports) vp.uploadBakedGrid(bakedGrid);
    lastBakeTime = state.timeSec;
  }

  if (forceBake || state.timeSec - lastStatsTime > 0.45) {
    UpdateErrorMetrics(forceBake);
    lastStatsTime = state.timeSec;
  }
}

function GetActiveApproxLightList() {
  return state.mode === 'naive' ? naiveLights : activeCut;
}

function UpdateHeadlightDiagnostic() {
  const banner = document.getElementById('HeadlightStatusBanner');
  const title = document.getElementById('HeadlightBannerTitle');
  const body = document.getElementById('HeadlightBannerBody');

  if (state.mode === 'naive') {
    banner.className = 'status-banner warn';
    title.textContent = '⚠ Headlights MERGED @ Center (Naive Average Bug!)';
    body.textContent = 'Left (5) + Right (5) averaged at grille center (0, 0.64, -2.1) → wrong shadows behind pillars & 1 blob instead of 2 beams.';
    return;
  }
  if (state.mode === 'grid') {
    banner.className = 'status-banner';
    title.textContent = `1-Sample Baked Directional Grid (${state.gridRes}×${state.gridRes} Cells)`;
    body.textContent = 'Conserves 100% of flux in L0 + stores Dominant Direction L1. Smooth diffuse, but watch sharp pillar shadows & dual-headlight specular in the Error Heatmap!';
    return;
  }

  // Inspect actual active BVH cut to detect whether Left & Right headlights are SPLIT or MERGED!
  let leftAndRightMerged = false;
  let headlightNodes = 0;
  for (const node of activeCut) {
    const hasLeft = node.members.some((m) => m.subGroup === 'LeftHeadlight');
    const hasRight = node.members.some((m) => m.subGroup === 'RightHeadlight');
    if (hasLeft && hasRight) leftAndRightMerged = true;
    if (hasLeft || hasRight) headlightNodes++;
  }
  const distToCar = Math.hypot(state.probePos[0], state.probePos[1] + 2.1);

  if (leftAndRightMerged) {
    banner.className = 'status-banner';
    title.textContent = `✓ Headlights MERGED @ Far Distance (${distToCar.toFixed(1)}m)`;
    body.textContent = `Probe is far enough that angular spread (1.64m / ${distToCar.toFixed(1)}m) < budget → merged with flux SUMMED (34.0 lm), saving light evals safely!`;
  } else {
    banner.className = 'status-banner';
    title.textContent = `✓ Headlights SPLIT (${headlightNodes} Nodes) @ Close Range (${distToCar.toFixed(1)}m)`;
    body.textContent = '5 LEDs inside Left Headlight merged (5→1) & 5 LEDs in Right merged (5→1), while Left & Right STAY SEPARATE for crisp twin beams & shadows!';
  }
}

function UpdateErrorMetrics(recordPoint = false) {
  const stats = EvaluateModeErrorStats(state.mode, rawLights, naiveLights, bvhRoot, bakedGrid, {
    errorThreshold: state.lodThreshold,
    maxActiveLights: state.maxActiveLights,
    hybridErrorGate: state.hybridErrorGate,
  });

  document.getElementById('MetricRmse').textContent = stats.rmse.toFixed(4);
  document.getElementById('MetricPsnr').innerHTML = `${stats.psnr.toFixed(1)}<small>dB</small>`;
  document.getElementById('MetricEvals').innerHTML = `${stats.avgEvals.toFixed(1)}<small>/px</small>`;
  document.getElementById('MetricSpeedup').innerHTML = `${stats.speedup.toFixed(1)}<small>&times;</small>`;
  document.getElementById('ApproxEvalBadge').textContent = `${stats.avgEvals.toFixed(1)} avg evals / px`;
  document.getElementById('FootGrid').textContent = `${state.gridRes}×${state.gridRes}`;
  document.getElementById('FootCut').textContent = `${GetActiveApproxLightList().length} active lights`;

  if (recordPoint || state.errorHistory.length === 0) {
    state.errorHistory.push({ label: `${state.mode[0].toUpperCase()}${state.refineStep}`, rmse: stats.rmse, evals: stats.avgEvals });
    if (state.errorHistory.length > 18) state.errorHistory.shift();
    DrawErrorChart();
  }
  UpdateHeadlightDiagnostic();
}

function DrawErrorChart() {
  const c = document.getElementById('ErrorChartCanvas');
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);

  // Subtle horizontal reference grid
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = (h / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const hist = state.errorHistory;
  if (hist.length === 0) return;
  const maxR = Math.max(0.18, ...hist.map((p) => p.rmse));

  ctx.strokeStyle = '#5bdb87';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  for (let i = 0; i < hist.length; i++) {
    const x = hist.length === 1 ? w * 0.5 : 14 + (i / (hist.length - 1)) * (w - 28);
    const y = h - 14 - (hist[i].rmse / maxR) * (h - 28);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  for (let i = 0; i < hist.length; i++) {
    const x = hist.length === 1 ? w * 0.5 : 14 + (i / (hist.length - 1)) * (w - 28);
    const y = h - 14 - (hist[i].rmse / maxR) * (h - 28);
    ctx.fillStyle = i === hist.length - 1 ? '#ffb454' : '#5bdb87';
    ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
  }

  const latest = hist[hist.length - 1];
  ctx.fillStyle = '#aeb4c0';
  ctx.font = '500 9.5px "DM Sans", sans-serif';
  ctx.fillText(`RMSE CONVERGENCE (NOW: ${latest.rmse.toFixed(4)})`, 8, 13);
}

function SelectMode(mode) {
  state.mode = mode;
  const meta = MODE_META[mode];
  document.getElementById('ApproxTitle').textContent = meta.title;
  document.getElementById('ApproxSub').textContent = meta.sub;
  document.getElementById('ApproxDot').className = `dot ${meta.dot}`;
  document.querySelectorAll('#ModeSelector .mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  RecomputeLightingData(true);
}

function UpdateRangeFill(el) {
  const min = parseFloat(el.min), max = parseFloat(el.max), val = parseFloat(el.value);
  el.style.setProperty('--fill', `${((val - min) / Math.max(1e-6, max - min)) * 100}%`);
}

function SyncSliderUI(id, outId, val, fmt) {
  const el = document.getElementById(id);
  el.value = String(val);
  document.getElementById(outId).textContent = fmt(val);
  UpdateRangeFill(el);
}

function RunErrorGuidedRefinementStep() {
  state.refineStep++;
  document.getElementById('RefineIterLabel').textContent = `Step ${state.refineStep}`;

  // Step 1: If user is on Naive Merge, jump straight to Baked Directional Grid so they see the first big drop!
  if (state.mode === 'naive') {
    SelectMode('grid');
    return;
  }
  // Step 2: If on pure Grid, promote to Error-Guided Hybrid (uses measured per-cell error to split ONLY high-error cells!)
  if (state.mode === 'grid') {
    state.showHybridMask = true;
    SyncQuickTiles();
    SelectMode('hybrid');
    return;
  }
  // Step 3+: Iteratively tighten error gates + increase grid resolution + expand BVH split budget using measured error!
  state.hybridErrorGate = Math.max(0.03, +(state.hybridErrorGate * 0.72).toFixed(2));
  state.lodThreshold = Math.max(0.06, +(state.lodThreshold * 0.78).toFixed(2));
  state.maxActiveLights = Math.min(24, state.maxActiveLights + 2);
  if (state.gridRes < 32 && state.refineStep % 2 === 1) {
    state.gridRes = Math.min(32, state.gridRes + 4);
  }
  SyncSliderUI('RangeGridRes', 'OutGridRes', state.gridRes, (v) => `${v}×${v}`);
  SyncSliderUI('RangeLodThreshold', 'OutLodThreshold', state.lodThreshold, (v) => v.toFixed(2));
  SyncSliderUI('RangeHybridGate', 'OutHybridGate', state.hybridErrorGate, (v) => v.toFixed(2));
  RecomputeLightingData(true);
}

function SyncQuickTiles() {
  const setT = (id, txtId, on) => {
    const el = document.getElementById(id);
    el.classList.toggle('on', on);
    el.classList.toggle('off', !on);
    document.getElementById(txtId).textContent = on ? 'ON' : 'OFF';
  };
  setT('TileShowGrid', 'TxtShowGrid', state.showGrid);
  setT('TileShowLights', 'TxtShowLights', state.showLights);
  setT('TileShowHybridMask', 'TxtShowHybridMask', state.showHybridMask);
  setT('TileAnimateDrone', 'TxtAnimateDrone', state.animateDrone);
}

//------------------------------------------------------------------------------------------------------------------------
//                                           INPUT & CAMERA INTERACTION
//------------------------------------------------------------------------------------------------------------------------

function InitUI() {
  document.querySelectorAll('input[type="range"]').forEach(UpdateRangeFill);

  document.querySelectorAll('#ModeSelector .mode-btn').forEach((b) => {
    b.addEventListener('click', () => SelectMode(b.dataset.mode));
  });

  document.getElementById('BtnAutoRefine').addEventListener('click', RunErrorGuidedRefinementStep);
  document.getElementById('BtnResetRefine').addEventListener('click', () => {
    state.refineStep = 0;
    state.errorHistory = [];
    state.gridRes = 16;
    state.lodThreshold = 0.24;
    state.hybridErrorGate = 0.18;
    state.maxActiveLights = 12;
    state.showHybridMask = false;
    document.getElementById('RefineIterLabel').textContent = 'Step 0';
    SyncSliderUI('RangeGridRes', 'OutGridRes', state.gridRes, (v) => `${v}×${v}`);
    SyncSliderUI('RangeLodThreshold', 'OutLodThreshold', state.lodThreshold, (v) => v.toFixed(2));
    SyncSliderUI('RangeHybridGate', 'OutHybridGate', state.hybridErrorGate, (v) => v.toFixed(2));
    SyncQuickTiles();
    SelectMode('naive');
  });

  // Camera presets
  const presets = {
    angle:      { yaw: 0.42, pitch: 0.68, dist: 20.5, target: [0.0, 0.4, 0.2] },
    top:        { yaw: 0.0,  pitch: 1.54, dist: 25.0, target: [0.0, 0.0, 0.0] },
    headlights: { yaw: 0.22, pitch: 0.42, dist: 10.5, target: [0.0, 0.5, 0.4] },
    neon:       { yaw: 0.85, pitch: 0.54, dist: 12.0, target: [5.2, 0.7, -1.8] },
  };
  document.querySelectorAll('#CamPresetGroup button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#CamPresetGroup button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const p = presets[b.dataset.cam];
      state.yaw = p.yaw; state.pitch = p.pitch; state.dist = p.dist; state.target = [...p.target];
    });
  });

  // Quick Debug Tiles
  document.getElementById('TileShowGrid').addEventListener('click', () => { state.showGrid = !state.showGrid; SyncQuickTiles(); });
  document.getElementById('TileShowLights').addEventListener('click', () => { state.showLights = !state.showLights; SyncQuickTiles(); });
  document.getElementById('TileShowHybridMask').addEventListener('click', () => { state.showHybridMask = !state.showHybridMask; SyncQuickTiles(); });
  document.getElementById('TileAnimateDrone').addEventListener('click', () => { state.animateDrone = !state.animateDrone; SyncQuickTiles(); });

  const bindRange = (id, outId, fmt, fn) => {
    const el = document.getElementById(id);
    const out = document.getElementById(outId);
    el.addEventListener('input', () => {
      UpdateRangeFill(el);
      const v = parseFloat(el.value);
      out.textContent = fmt(v);
      fn(v);
    });
  };
  bindRange('RangeGridRes', 'OutGridRes', (v) => `${Math.round(v)}×${Math.round(v)}`, (v) => { state.gridRes = Math.round(v); RecomputeLightingData(true); });
  bindRange('RangeLodThreshold', 'OutLodThreshold', (v) => v.toFixed(2), (v) => { state.lodThreshold = v; RecomputeLightingData(true); });
  bindRange('RangeHybridGate', 'OutHybridGate', (v) => v.toFixed(2), (v) => { state.hybridErrorGate = v; RecomputeLightingData(true); });
  bindRange('RangeErrorGain', 'OutErrorGain', (v) => v.toFixed(1), (v) => { state.errorGain = v; });
  bindRange('RangeRoughness', 'OutRoughness', (v) => v.toFixed(2), (v) => { state.floorRoughness = v; });

  // Synchronized Orbit + Click-Floor-to-Place-Probe across ALL 3 viewports!
  for (const vp of allViewports) {
    let dragging = false;
    let moved = false;
    let lastX = 0, lastY = 0;

    vp.overlayCanvas.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
      vp.overlayCanvas.setPointerCapture(e.pointerId);
    });
    vp.overlayCanvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (Math.hypot(dx, dy) > 2) moved = true;
      lastX = e.clientX; lastY = e.clientY;
      state.yaw -= dx * 0.007;
      state.pitch = Math.max(0.16, Math.min(1.55, state.pitch + dy * 0.007));
    });
    vp.overlayCanvas.addEventListener('pointerup', (e) => {
      if (dragging && !moved) {
        const hit = vp.unprojectToFloor(BuildCameraFrame(), e.clientX, e.clientY);
        if (hit) {
          state.probePos = hit;
          RecomputeLightingData(true);
        }
      }
      dragging = false;
    });
    vp.overlayCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.dist = Math.max(6.5, Math.min(36.0, state.dist * (1.0 + e.deltaY * 0.001)));
    }, { passive: false });
  }
}

function Tick(nowMs) {
  requestAnimationFrame(Tick);
  const dt = Math.min(0.05, Math.max(0.001, (nowMs - lastFrameMs) / 1000.0));
  lastFrameMs = nowMs;
  if (state.animateDrone) state.timeSec += dt;
  fpsSmooth = fpsSmooth * 0.9 + (1.0 / dt) * 0.1;
  document.getElementById('FootFps').textContent = String(Math.round(fpsSmooth));

  RecomputeLightingData(false);
  const cam = BuildCameraFrame();
  const approxList = GetActiveApproxLightList();
  const modeId = MODE_META[state.mode].id;

  const commonParams = {
    compareTarget: modeId,
    errorGain: state.errorGain,
    floorRoughness: state.floorRoughness,
    hybridErrorGate: state.hybridErrorGate,
    gridRes: state.gridRes,
    showGrid: state.showGrid,
    showHybridMask: state.showHybridMask,
  };

  // Render all 3 synchronized WebGL viewports
  vpTruth.render(cam, rawLights, approxList, { ...commonParams, viewMode: 0 });
  vpApprox.render(cam, rawLights, approxList, { ...commonParams, viewMode: modeId });
  vpError.render(cam, rawLights, approxList, { ...commonParams, viewMode: 5 });

  // Draw crisp 3D-projected Light Grid, Merge Tree & Receiver Probe overlays
  const overlayBase = {
    rawLights,
    approxLights: approxList,
    bakedGrid,
    showGrid: state.showGrid,
    showLights: state.showLights,
    approxMode: state.mode,
    probePos: state.probePos,
  };
  vpTruth.drawDebugOverlay(cam, { ...overlayBase, panelRole: 'truth' });
  vpApprox.drawDebugOverlay(cam, { ...overlayBase, panelRole: 'approx' });
  vpError.drawDebugOverlay(cam, { ...overlayBase, panelRole: 'error', showLights: false });
}

InitUI();
SyncQuickTiles();
SelectMode('naive');
requestAnimationFrame(Tick);
