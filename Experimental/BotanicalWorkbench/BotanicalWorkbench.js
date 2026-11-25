/*============================================================================================================================================
                                                         BOTANICALWORKBENCH.JS
============================================================================================================================================*/
// 🧩 Interactive Frontier Botanical Workbench: 37 Slate species, 1 shared WindField, 128-tri Clusters, UV unwrap, Fracture, 10,240-tree Forest & Wind-SDF

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { SpeciesGroups, SpeciesPresets, FindSpeciesPreset } from './Engine/SpeciesPresets.js';
import { GenerateBotanicalSpecimen } from './Engine/WeberPennGenerator.js';
import {
  CreateDefaultWindParameters,
  SampleUnifiedWind,
  UNIFIED_WIND_GLSL_UNIFORMS,
  UNIFIED_WIND_GLSL_FUNCTIONS,
} from './Engine/UnifiedWindField.js';
import {
  BuildClusteredBuffers,
  SplitSpecimenForFracture,
  ConstructBarkTextureCanvas,
  ConstructUvCheckerCanvas,
  ConstructLeafTextureCanvas,
  EvaluateWindDeformedSdfPrimitives,
  RenderGdfCrossSection,
} from './Engine/ClusterFractureSdf.js';

//------------------------------------------------------------------------------------------------------------------------
//                                                 WORKBENCH CONFIGURATION
//------------------------------------------------------------------------------------------------------------------------

const workbench = {
  presetName: 'English Oak',
  seed: 1337,
  scaleMul: 1.0,
  levelsOverride: null,
  leafScaleMul: 1.0,
  flareOverride: null,
  tropismOverride: null,
  lodTier: 0,
  uvScale: 1.0,
  renderMode: 'pbr',     // pbr | clusters | uv | sdf | wind | fracture
  forestCount: 1,        // 1 | 64 | 10240
  leafShuffleMode: 0,    // 0=Analytic, 1=VAT Sheet, 2=Hero XPBD
  showClusterSpheres: false,
  showSdfGizmos: false,
  showGdfPanel: true,
  showWindArrows: false,
  sdfSmoothK: 0.65,
  cutHeightNorm: 0.28,
  snapImpulse: 1.0,
  wind: CreateDefaultWindParameters(),
  selectedOutlinerId: 'specimen',
  outlinerFilter: 'all',
  outlinerQuery: '',
  visibility: {
    bark: true,
    foliage: true,
    sdf: false,
    wind: false,
    forest: true,
  },
};

const runtime = {
  specimen: null,
  clusteredBark: null,
  clusteredFoliage: null,
  barkTex: null,
  leafTex: null,
  uvCheckerTex: null,
  heroGroup: null,
  barkMesh: null,
  leafMesh: null,
  forestGroup: null,
  clusterSphereGroup: null,
  sdfGizmoGroup: null,
  sdfCapsuleMeshes: [],
  sdfLobeMeshes: [],
  windArrowGroup: null,
  windArrows: [],
  fractureActive: false,
  fractureGroup: null,
  fractureCrownPivot: null,
  fractureCutY: 0,
  fractureTilt: 0,
  fractureVel: 0,
  fractureAxis: new THREE.Vector3(0, 0, 1),
  fractureSplinters: [],
  timeSec: 0,
  lastFrameMs: performance.now(),
  fpsSmooth: 60,
  gdfFrameCounter: 0,
  sharedUniforms: {
    uTime: { value: 0 },
    uWindDirXZ: { value: new THREE.Vector2(Math.cos(35 * Math.PI / 180), Math.sin(35 * Math.PI / 180)) },
    uWindSpeed: { value: 6.5 },
    uWindGust: { value: 0.45 },
    uWindFreq: { value: 0.55 },
    uWindWavelength: { value: 28.0 },
    uWindTurb: { value: 0.35 },
    uVortexEnabled: { value: 0.0 },
    uVortexRadius: { value: 14.0 },
    uVortexStrength: { value: 0.65 },
    uSpecimenHeight: { value: 16.0 },
    uTrunkFlex: { value: 1.0 },
    uLimbFlex: { value: 1.0 },
    uDetailFlex: { value: 1.0 },
    uLeafShuffleMode: { value: 0.0 },
    uRenderMode: { value: 0.0 }, // 0=PBR, 1=Clusters, 2=UV
    uSunDir: { value: new THREE.Vector3(0.55, 0.72, 0.42).normalize() },
  },
};

//------------------------------------------------------------------------------------------------------------------------
//                                                    THREE.JS VIEWPORT
//------------------------------------------------------------------------------------------------------------------------

const canvas = document.getElementById('ViewportCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0d121a');
scene.fog = new THREE.FogExp2('#0e141e', 0.0042);

const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.15, 900);
camera.position.set(16, 11, 20);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.maxPolarAngle = Math.PI * 0.495;
controls.target.set(0, 6.5, 0);

// Atmospheric Sky Dome
const skyGeo = new THREE.SphereGeometry(420, 32, 20);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    uSunDir: runtime.sharedUniforms.uSunDir,
  },
  vertexShader: `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uSunDir;
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float h = clamp(d.y, 0.0, 1.0);
      vec3 horizon = vec3(0.18, 0.24, 0.34);
      vec3 zenith  = vec3(0.05, 0.09, 0.17);
      vec3 col = mix(horizon, zenith, pow(h, 0.55));
      float sunAmt = max(dot(d, normalize(uSunDir)), 0.0);
      col += vec3(1.0, 0.85, 0.62) * pow(sunAmt, 64.0) * 0.85;
      col += vec3(0.55, 0.48, 0.38) * pow(sunAmt, 6.0) * 0.25;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
scene.add(new THREE.Mesh(skyGeo, skyMat));

// Ground plane + crisp studio reference grid
const groundMesh = new THREE.Mesh(
  new THREE.CircleGeometry(360, 64),
  new THREE.MeshStandardMaterial({ color: '#171c19', roughness: 0.94, metalness: 0.0 })
);
groundMesh.rotation.x = -Math.PI * 0.5;
groundMesh.receiveShadow = true;
scene.add(groundMesh);

const gridHelper = new THREE.GridHelper(120, 40, 0x33404f, 0x1d232b);
gridHelper.position.y = 0.01;
scene.add(gridHelper);

// Key Sun + Hemisphere Skylight
const sunLight = new THREE.DirectionalLight('#fff2dc', 2.4);
sunLight.position.set(28, 38, 22);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(1024, 1024);
sunLight.shadow.camera.near = 2;
sunLight.shadow.camera.far = 120;
const sc = 24;
sunLight.shadow.camera.left = -sc;
sunLight.shadow.camera.right = sc;
sunLight.shadow.camera.top = sc;
sunLight.shadow.camera.bottom = -sc;
scene.add(sunLight);
scene.add(new THREE.HemisphereLight('#7fa4d4', '#2a241d', 0.85));

// Permanent UV Checker Texture
runtime.uvCheckerTex = new THREE.CanvasTexture(ConstructUvCheckerCanvas());
runtime.uvCheckerTex.wrapS = THREE.RepeatWrapping;
runtime.uvCheckerTex.wrapT = THREE.RepeatWrapping;
runtime.uvCheckerTex.colorSpace = THREE.SRGBColorSpace;

//------------------------------------------------------------------------------------------------------------------------
//                                           CUSTOM GPU WIND SHADER MATERIALS
//------------------------------------------------------------------------------------------------------------------------

function CreateBarkMaterial(barkTex, isInstanced = false) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...runtime.sharedUniforms,
      uBarkMap: { value: barkTex },
      uUvCheckerMap: { value: runtime.uvCheckerTex },
      uIsInstanced: { value: isInstanced ? 1.0 : 0.0 },
    },
    vertexShader: `
      attribute vec4 aWind;
      attribute vec3 aPivot;
      attribute vec3 aClusterColor;
      ${UNIFIED_WIND_GLSL_UNIFORMS}
      uniform float uIsInstanced;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vClusterColor;
      varying float vHeightNorm;
      ${UNIFIED_WIND_GLSL_FUNCTIONS}
      void main() {
        vUv = uv;
        vClusterColor = aClusterColor;
        vHeightNorm = aWind.x;
        vec3 worldOrigin = vec3(0.0);
        mat4 instMat = mat4(1.0);
        #ifdef USE_INSTANCING
          instMat = instanceMatrix;
          worldOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #endif
        vec3 displaced = frontierApplyUnifiedWind(position, worldOrigin, aWind, aPivot);
        vec4 worldPos = modelMatrix * instMat * vec4(displaced, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * mat3(instMat) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform sampler2D uBarkMap;
      uniform sampler2D uUvCheckerMap;
      uniform float uRenderMode;
      uniform vec3 uSunDir;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vClusterColor;
      varying float vHeightNorm;
      void main() {
        vec3 N = normalize(vNormalW);
        vec3 L = normalize(uSunDir);
        float ndl = max(dot(N, L), 0.0);
        float hemi = 0.5 + 0.5 * N.y;
        vec3 lit = vec3(0.24, 0.28, 0.34) * hemi + vec3(1.12, 1.04, 0.92) * ndl;
        vec3 baseCol;
        if (uRenderMode > 0.5 && uRenderMode < 1.5) {
          baseCol = vClusterColor;
        } else if (uRenderMode >= 1.5) {
          baseCol = texture2D(uUvCheckerMap, vUv).rgb;
        } else {
          baseCol = texture2D(uBarkMap, vUv).rgb * (0.72 + 0.28 * vHeightNorm);
        }
        vec3 finalCol = baseCol * lit;
        gl_FragColor = vec4(finalCol, 1.0);
      }
    `,
  });
}

function CreateFoliageMaterial(leafTex, isInstanced = false) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      ...runtime.sharedUniforms,
      uLeafMap: { value: leafTex },
      uUvCheckerMap: { value: runtime.uvCheckerTex },
      uIsInstanced: { value: isInstanced ? 1.0 : 0.0 },
    },
    vertexShader: `
      attribute vec4 aWind;
      attribute vec3 aPivot;
      attribute vec3 aClusterColor;
      attribute float aTintVar;
      ${UNIFIED_WIND_GLSL_UNIFORMS}
      uniform float uIsInstanced;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vClusterColor;
      varying float vTintVar;
      varying float vHeightNorm;
      ${UNIFIED_WIND_GLSL_FUNCTIONS}
      void main() {
        vUv = uv;
        vClusterColor = aClusterColor;
        vTintVar = aTintVar;
        vHeightNorm = aWind.x;
        vec3 worldOrigin = vec3(0.0);
        mat4 instMat = mat4(1.0);
        #ifdef USE_INSTANCING
          instMat = instanceMatrix;
          worldOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #endif
        vec3 displaced = frontierApplyUnifiedWind(position, worldOrigin, aWind, aPivot);
        vec4 worldPos = modelMatrix * instMat * vec4(displaced, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * mat3(instMat) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform sampler2D uLeafMap;
      uniform sampler2D uUvCheckerMap;
      uniform float uRenderMode;
      uniform vec3 uSunDir;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vClusterColor;
      varying float vTintVar;
      varying float vHeightNorm;
      void main() {
        vec4 tex = texture2D(uLeafMap, vUv);
        if (tex.a < 0.32 && uRenderMode < 1.5) discard;
        vec3 N = normalize(gl_FrontFacing ? vNormalW : -vNormalW);
        vec3 L = normalize(uSunDir);
        float ndl = max(dot(N, L), 0.0);
        // Subsurface translucency backlit through canopy leaves
        float sss = pow(max(dot(-N, L), 0.0), 2.0) * 0.42;
        float hemi = 0.5 + 0.5 * N.y;
        vec3 lit = vec3(0.24, 0.30, 0.36) * hemi + vec3(1.15, 1.06, 0.90) * (ndl + sss);
        vec3 baseCol;
        if (uRenderMode > 0.5 && uRenderMode < 1.5) {
          baseCol = vClusterColor;
        } else if (uRenderMode >= 1.5) {
          baseCol = texture2D(uUvCheckerMap, vUv).rgb;
        } else {
          float tintShift = 0.86 + 0.28 * vTintVar;
          baseCol = tex.rgb * tintShift * (0.68 + 0.38 * vHeightNorm);
        }
        gl_FragColor = vec4(baseCol * lit, 1.0);
      }
    `,
  });
}

function BuildThreeGeometry(clustered, includeTint = false) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(clustered.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(clustered.normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(clustered.uvs, 2));
  geo.setAttribute('aWind', new THREE.BufferAttribute(clustered.wind, 4));
  geo.setAttribute('aPivot', new THREE.BufferAttribute(clustered.pivots, 3));
  geo.setAttribute('aClusterColor', new THREE.BufferAttribute(clustered.clusterColors, 3));
  if (includeTint && clustered.tint) {
    geo.setAttribute('aTintVar', new THREE.BufferAttribute(clustered.tint, 1));
  }
  geo.computeBoundingSphere();
  return geo;
}

//------------------------------------------------------------------------------------------------------------------------
//                                           SPECIMEN & FOREST BUILD PIPELINE
//------------------------------------------------------------------------------------------------------------------------

function DisposeObject3D(obj) {
  if (!obj) return;
  obj.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
      else child.material.dispose();
    }
  });
}

function BuildActivePresetDescriptor() {
  const raw = FindSpeciesPreset(workbench.presetName);
  const clone = JSON.parse(JSON.stringify(raw));
  clone.botany.scale *= workbench.scaleMul;
  clone.botany.leafScale *= workbench.leafScaleMul;
  if (workbench.levelsOverride !== null) clone.botany.levels = workbench.levelsOverride;
  if (workbench.flareOverride !== null) clone.botany.flare = workbench.flareOverride;
  if (workbench.tropismOverride !== null) clone.botany.attractionUp = workbench.tropismOverride;
  return clone;
}

function RebuildWindVectorGrid() {
  if (runtime.windArrowGroup) {
    scene.remove(runtime.windArrowGroup);
    DisposeObject3D(runtime.windArrowGroup);
  }
  runtime.windArrowGroup = new THREE.Group();
  runtime.windArrows = [];
  const gridN = 7;
  const spacing = 5.5;
  const hY = Math.max(4.5, (runtime.specimen?.height || 14) * 0.65);

  const shaftGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6);
  shaftGeo.translate(0, 0.5, 0);
  shaftGeo.rotateX(Math.PI * 0.5);
  const headGeo = new THREE.ConeGeometry(0.16, 0.42, 8);
  headGeo.translate(0, 1.15, 0);
  headGeo.rotateX(Math.PI * 0.5);

  for (let gx = -3; gx <= 3; gx++) {
    for (let gz = -3; gz <= 3; gz++) {
      const grp = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: '#45d4ff', transparent: true, opacity: 0.72 });
      grp.add(new THREE.Mesh(shaftGeo, mat));
      grp.add(new THREE.Mesh(headGeo, mat));
      grp.position.set(gx * spacing, hY, gz * spacing);
      runtime.windArrowGroup.add(grp);
      runtime.windArrows.push({ group: grp, mat, wx: gx * spacing, wy: hY, wz: gz * spacing });
    }
  }
  runtime.windArrowGroup.visible = workbench.showWindArrows || workbench.renderMode === 'wind';
  scene.add(runtime.windArrowGroup);
}

function RebuildSdfGizmos() {
  if (runtime.sdfGizmoGroup) {
    scene.remove(runtime.sdfGizmoGroup);
    DisposeObject3D(runtime.sdfGizmoGroup);
  }
  runtime.sdfGizmoGroup = new THREE.Group();
  runtime.sdfCapsuleMeshes = [];
  runtime.sdfLobeMeshes = [];

  const capGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, false);
  const capMat = new THREE.MeshBasicMaterial({ color: '#38bdf8', wireframe: true, transparent: true, opacity: 0.72 });
  for (const cap of runtime.specimen.sdfCapsules) {
    const m = new THREE.Mesh(capGeo, capMat);
    runtime.sdfGizmoGroup.add(m);
    runtime.sdfCapsuleMeshes.push(m);
  }

  const sphGeo = new THREE.IcosahedronGeometry(1, 1);
  const sphMat = new THREE.MeshBasicMaterial({ color: '#ffb454', wireframe: true, transparent: true, opacity: 0.42 });
  for (const lobe of runtime.specimen.sdfCanopyLobes) {
    const m = new THREE.Mesh(sphGeo, sphMat);
    runtime.sdfGizmoGroup.add(m);
    runtime.sdfLobeMeshes.push(m);
  }

  runtime.sdfGizmoGroup.visible = workbench.showSdfGizmos || workbench.renderMode === 'sdf';
  scene.add(runtime.sdfGizmoGroup);
}

function RebuildClusterSpheres() {
  if (runtime.clusterSphereGroup) {
    scene.remove(runtime.clusterSphereGroup);
    DisposeObject3D(runtime.clusterSphereGroup);
  }
  runtime.clusterSphereGroup = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const allSpheres = [
    ...runtime.clusteredBark.clusterSpheres,
    ...runtime.clusteredFoliage.clusterSpheres.slice(0, 64),
  ];
  for (const sp of allSpheres) {
    const mat = new THREE.MeshBasicMaterial({ color: '#a78bfa', wireframe: true, transparent: true, opacity: 0.24 });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(sp.center[0], sp.center[1], sp.center[2]);
    m.scale.setScalar(sp.radius);
    runtime.clusterSphereGroup.add(m);
  }
  runtime.clusterSphereGroup.visible = workbench.showClusterSpheres;
  scene.add(runtime.clusterSphereGroup);
}

function RebuildForestInstances() {
  if (runtime.forestGroup) {
    scene.remove(runtime.forestGroup);
    DisposeObject3D(runtime.forestGroup);
    runtime.forestGroup = null;
  }
  if (workbench.forestCount <= 1 || !workbench.visibility.forest) {
    if (runtime.heroGroup) runtime.heroGroup.visible = !runtime.fractureActive;
    UpdateTelemetryUI();
    return;
  }

  // Generate an optimized LOD3 forest cluster prototype for 64 or 10,240 GPU instances
  const desc = BuildActivePresetDescriptor();
  const forestLod = workbench.forestCount > 500 ? 3 : 2;
  const proto = GenerateBotanicalSpecimen(desc, { seed: workbench.seed + 77, lodTier: forestLod, uvScale: workbench.uvScale });
  const cBark = BuildClusteredBuffers(proto.bark, 0, false);
  const cLeaf = BuildClusteredBuffers(proto.foliage, cBark.clusterCount, true);

  const count = workbench.forestCount - 1; // hero sits at origin
  runtime.forestGroup = new THREE.Group();

  const barkGeo = BuildThreeGeometry(cBark, false);
  const barkMat = CreateBarkMaterial(runtime.barkTex, true);
  const instBark = new THREE.InstancedMesh(barkGeo, barkMat, count);

  let instLeaf = null;
  if (cLeaf.triangleCount > 0) {
    const leafGeo = BuildThreeGeometry(cLeaf, true);
    const leafMat = CreateFoliageMaterial(runtime.leafTex, true);
    instLeaf = new THREE.InstancedMesh(leafGeo, leafMat, count);
  }

  const dummy = new THREE.Object3D();
  const spacing = workbench.forestCount > 500 ? 4.4 : 9.5;
  const gridSide = Math.ceil(Math.sqrt(count));
  const half = (gridSide * spacing) * 0.5;
  let placed = 0;

  for (let gx = 0; gx < gridSide && placed < count; gx++) {
    for (let gz = 0; gz < gridSide && placed < count; gz++) {
      const hash = Math.sin(gx * 12.9898 + gz * 78.233) * 43758.5453;
      const fracA = hash - Math.floor(hash);
      const fracB = (hash * 1.37) - Math.floor(hash * 1.37);
      const wx = gx * spacing - half + (fracA - 0.5) * spacing * 0.72;
      const wz = gz * spacing - half + (fracB - 0.5) * spacing * 0.72;
      if (Math.hypot(wx, wz) < Math.max(7.5, runtime.specimen.height * 0.65)) continue;
      const sc = 0.72 + fracA * 0.58;
      dummy.position.set(wx, 0, wz);
      dummy.rotation.set(0, fracB * Math.PI * 2.0, 0);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      instBark.setMatrixAt(placed, dummy.matrix);
      if (instLeaf) instLeaf.setMatrixAt(placed, dummy.matrix);
      placed++;
    }
  }
  instBark.count = placed;
  instBark.instanceMatrix.needsUpdate = true;
  runtime.forestGroup.add(instBark);

  if (instLeaf) {
    instLeaf.count = placed;
    instLeaf.instanceMatrix.needsUpdate = true;
    runtime.forestGroup.add(instLeaf);
  }

  scene.add(runtime.forestGroup);
  UpdateTelemetryUI();
}

function ResetFracture() {
  runtime.fractureActive = false;
  if (runtime.fractureGroup) {
    scene.remove(runtime.fractureGroup);
    DisposeObject3D(runtime.fractureGroup);
    runtime.fractureGroup = null;
    runtime.fractureCrownPivot = null;
    runtime.fractureSplinters = [];
  }
  if (runtime.heroGroup) runtime.heroGroup.visible = true;
  document.getElementById('HudFractureChip').style.display = 'none';
  document.getElementById('MetricStumpTris').textContent = '-';
  document.getElementById('MetricCrownTris').textContent = '-';
  document.getElementById('MetricSplinters').textContent = '0';
  document.getElementById('MetricCrownTilt').textContent = '0.0°';
}

function TriggerFracture() {
  ResetFracture();
  if (!runtime.clusteredBark || !runtime.clusteredFoliage) return;
  const split = SplitSpecimenForFracture(
    runtime.clusteredBark,
    runtime.clusteredFoliage,
    runtime.specimen.height,
    workbench.cutHeightNorm
  );
  runtime.fractureActive = true;
  runtime.fractureCutY = split.cutY;
  runtime.fractureTilt = 0;
  runtime.fractureVel = 0.35 * workbench.snapImpulse;

  // Fall downwind from the unified WindField direction
  const rad = (workbench.wind.directionDeg * Math.PI) / 180.0;
  runtime.fractureAxis.set(-Math.sin(rad), 0, Math.cos(rad)).normalize();

  runtime.fractureGroup = new THREE.Group();
  const barkMat = CreateBarkMaterial(runtime.barkTex, false);
  const leafMat = CreateFoliageMaterial(runtime.leafTex, false);

  // Lower rooted stump
  if (split.bark.lower.triangleCount > 0) {
    const stumpMesh = new THREE.Mesh(BuildThreeGeometry(split.bark.lower, false), barkMat);
    runtime.fractureGroup.add(stumpMesh);
  }
  if (split.foliage.lower.triangleCount > 0) {
    const lowLeaf = new THREE.Mesh(BuildThreeGeometry(split.foliage.lower, true), leafMat);
    runtime.fractureGroup.add(lowLeaf);
  }

  // Exposed heartwood splinter disc on stump
  const stumpCap = new THREE.Mesh(
    new THREE.CylinderGeometry(runtime.specimen.trunkRadius * 0.72, runtime.specimen.trunkRadius * 0.85, 0.16, 10),
    new THREE.MeshStandardMaterial({ color: '#c9a675', roughness: 0.85 })
  );
  stumpCap.position.y = split.cutY - 0.04;
  runtime.fractureGroup.add(stumpCap);

  // Upper crown pivoted at the Voronoi break seam
  runtime.fractureCrownPivot = new THREE.Group();
  runtime.fractureCrownPivot.position.set(0, split.cutY, 0);
  const crownInner = new THREE.Group();
  crownInner.position.set(0, -split.cutY, 0);

  if (split.bark.upper.triangleCount > 0) {
    crownInner.add(new THREE.Mesh(BuildThreeGeometry(split.bark.upper, false), barkMat));
  }
  if (split.foliage.upper.triangleCount > 0) {
    crownInner.add(new THREE.Mesh(BuildThreeGeometry(split.foliage.upper, true), leafMat));
  }
  runtime.fractureCrownPivot.add(crownInner);
  runtime.fractureGroup.add(runtime.fractureCrownPivot);

  // Wood splinter debris shards blasted out from the cut
  runtime.fractureSplinters = [];
  const shardGeo = new THREE.BoxGeometry(0.08, 0.36, 0.05);
  const shardMat = new THREE.MeshStandardMaterial({ color: '#be9a68', roughness: 0.88 });
  for (let i = 0; i < 24; i++) {
    const ang = (i / 24) * Math.PI * 2.0 + Math.random() * 0.3;
    const m = new THREE.Mesh(shardGeo, shardMat);
    m.position.set(Math.cos(ang) * 0.25, split.cutY + (Math.random() - 0.5) * 0.2, Math.sin(ang) * 0.25);
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    runtime.fractureGroup.add(m);
    const spd = (2.2 + Math.random() * 3.8) * workbench.snapImpulse;
    runtime.fractureSplinters.push({
      mesh: m,
      vel: new THREE.Vector3(
        Math.cos(ang) * spd + Math.cos(rad) * 2.5,
        1.8 + Math.random() * 3.2,
        Math.sin(ang) * spd + Math.sin(rad) * 2.5
      ),
      rotVel: new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9),
    });
  }

  if (runtime.heroGroup) runtime.heroGroup.visible = false;
  scene.add(runtime.fractureGroup);

  document.getElementById('HudFractureChip').style.display = 'flex';
  document.getElementById('HudFractureStatus').textContent = `Snapped @ ${(workbench.cutHeightNorm * 100).toFixed(0)}% H`;
  document.getElementById('MetricStumpTris').textContent = split.bark.lower.triangleCount.toLocaleString();
  document.getElementById('MetricCrownTris').textContent = (split.bark.upper.triangleCount + split.foliage.upper.triangleCount).toLocaleString();
  document.getElementById('MetricSplinters').textContent = String(runtime.fractureSplinters.length);
}

function RebuildHeroSpecimen() {
  ResetFracture();
  const desc = BuildActivePresetDescriptor();
  const specimen = GenerateBotanicalSpecimen(desc, {
    seed: workbench.seed,
    lodTier: workbench.lodTier,
    uvScale: workbench.uvScale,
  });
  runtime.specimen = specimen;
  runtime.sharedUniforms.uSpecimenHeight.value = specimen.height;

  // Build 128-tri clustered buffers
  const clusteredBark = BuildClusteredBuffers(specimen.bark, 0, false);
  const clusteredFoliage = BuildClusteredBuffers(specimen.foliage, clusteredBark.clusterCount, true);
  runtime.clusteredBark = clusteredBark;
  runtime.clusteredFoliage = clusteredFoliage;

  // Procedural species bark + leaf PBR textures
  const barkCanvas = ConstructBarkTextureCanvas(desc.visual);
  const leafCanvas = ConstructLeafTextureCanvas(desc.visual);
  if (runtime.barkTex) runtime.barkTex.dispose();
  if (runtime.leafTex) runtime.leafTex.dispose();
  runtime.barkTex = new THREE.CanvasTexture(barkCanvas);
  runtime.barkTex.wrapS = THREE.RepeatWrapping;
  runtime.barkTex.wrapT = THREE.RepeatWrapping;
  runtime.barkTex.colorSpace = THREE.SRGBColorSpace;
  runtime.leafTex = new THREE.CanvasTexture(leafCanvas);
  runtime.leafTex.colorSpace = THREE.SRGBColorSpace;

  // Mirror textures into Inspector Swatch canvases
  const swBark = document.getElementById('SwatchBark').getContext('2d');
  swBark.clearRect(0, 0, 128, 128);
  swBark.drawImage(barkCanvas, 0, 0, 128, 128);
  const swLeaf = document.getElementById('SwatchLeaf').getContext('2d');
  swLeaf.clearRect(0, 0, 128, 128);
  swLeaf.drawImage(leafCanvas, 0, 0, 128, 128);

  if (runtime.heroGroup) {
    scene.remove(runtime.heroGroup);
    DisposeObject3D(runtime.heroGroup);
  }
  runtime.heroGroup = new THREE.Group();

  const barkGeo = BuildThreeGeometry(clusteredBark, false);
  const barkMat = CreateBarkMaterial(runtime.barkTex, false);
  runtime.barkMesh = new THREE.Mesh(barkGeo, barkMat);
  runtime.barkMesh.castShadow = true;
  runtime.barkMesh.receiveShadow = true;
  runtime.barkMesh.visible = workbench.visibility.bark;
  runtime.heroGroup.add(runtime.barkMesh);

  if (clusteredFoliage.triangleCount > 0) {
    const leafGeo = BuildThreeGeometry(clusteredFoliage, true);
    const leafMat = CreateFoliageMaterial(runtime.leafTex, false);
    runtime.leafMesh = new THREE.Mesh(leafGeo, leafMat);
    runtime.leafMesh.castShadow = true;
    runtime.leafMesh.visible = workbench.visibility.foliage;
    runtime.heroGroup.add(runtime.leafMesh);
  } else {
    runtime.leafMesh = null;
  }

  scene.add(runtime.heroGroup);
  RebuildClusterSpheres();
  RebuildSdfGizmos();
  RebuildWindVectorGrid();
  if (workbench.forestCount > 1) RebuildForestInstances();

  // Frame camera smoothly when switching species dramatically
  controls.target.set(0, specimen.height * 0.44, 0);
  RenderOutliner();
  UpdateTelemetryUI();
}

//------------------------------------------------------------------------------------------------------------------------
//                                           PROJECT ZERO OUTLINER & INSPECTOR UI
//------------------------------------------------------------------------------------------------------------------------

function GetOutlinerItems() {
  const sp = runtime.specimen;
  const barkTris = runtime.clusteredBark?.triangleCount || 0;
  const leafTris = runtime.clusteredFoliage?.triangleCount || 0;
  const totalClusters = (runtime.clusteredBark?.clusterCount || 0) + (runtime.clusteredFoliage?.clusterCount || 0);
  const sdfCount = (sp?.sdfCapsules.length || 0) + (sp?.sdfCanopyLobes.length || 0);

  return [
    { id: 'world',     depth: 0, name: 'Untitled · MainWorld',     cat: 'all',     color: '#34c759', meta: 'WorldSpace', pane: 'botany' },
    { id: 'atmo',      depth: 1, name: 'Sun & Clear Sky',          cat: 'all',     color: '#fbbf24', meta: '3-LUT Sky',  pane: 'botany' },
    { id: 'windfield', depth: 1, name: 'Global WindField (Shared)',cat: 'wind',    color: '#38bdf8', meta: `${workbench.wind.speedMps.toFixed(1)} m/s`, pane: 'wind', visKey: 'wind' },
    { id: 'specimen',  depth: 1, name: workbench.presetName,       cat: 'wood',    color: '#ffb454', meta: `${(sp?.height || 0).toFixed(1)}m`, pane: 'botany' },
    { id: 'bark',      depth: 2, name: 'Trunk · Boughs · Roots',   cat: 'wood',    color: '#a17a55', meta: `${barkTris.toLocaleString()} tris`, pane: 'cluster', visKey: 'bark' },
    { id: 'foliage',   depth: 2, name: 'Canopy Foliage Fronds',    cat: 'foliage', color: '#4ade80', meta: `${(sp?.leafCount || 0).toLocaleString()} leaves`, pane: 'botany', visKey: 'foliage' },
    { id: 'clusters',  depth: 2, name: '128-Tri LOD Clusters',     cat: 'wood',    color: '#a78bfa', meta: `${totalClusters} clus`, pane: 'cluster' },
    { id: 'fracture',  depth: 2, name: 'Voronoi Fracture Seam',    cat: 'wood',    color: '#f87171', meta: runtime.fractureActive ? 'Snapped' : 'Armed', pane: 'fracture' },
    { id: 'sdf',       depth: 2, name: 'Analytical SDF Proxies',   cat: 'sdf',     color: '#22d3ee', meta: `${sdfCount} prims`, pane: 'sdf', visKey: 'sdf' },
    { id: 'forest',    depth: 1, name: 'Instanced Forest Field',   cat: 'foliage', color: '#34c759', meta: `${workbench.forestCount.toLocaleString()} inst`, pane: 'cluster', visKey: 'forest' },
  ];
}

function RenderOutliner() {
  const container = document.getElementById('OutlinerRows');
  const query = workbench.outlinerQuery.trim().toLowerCase();
  const filter = workbench.outlinerFilter;
  const items = GetOutlinerItems().filter((it) => {
    if (filter !== 'all' && it.cat !== filter && it.depth === 2) return false;
    if (filter !== 'all' && it.id === 'windfield' && filter !== 'wind') return false;
    if (query && !it.name.toLowerCase().includes(query) && !it.meta.toLowerCase().includes(query)) return false;
    return true;
  });

  document.getElementById('OutlinerCountLabel').textContent = `${items.length} items`;
  container.innerHTML = '';

  for (const it of items) {
    const row = document.createElement('div');
    const isHidden = it.visKey && !workbench.visibility[it.visKey];
    row.className = `outliner-row${workbench.selectedOutlinerId === it.id ? ' selected' : ''}${isHidden ? ' hidden-row' : ''}`;
    row.style.setProperty('--depth', it.depth);
    row.innerHTML = `
      <span class="row-caret">${it.depth < 2 ? '▾' : ''}</span>
      <span class="row-token" style="background:${it.color};"></span>
      <span class="row-name">${it.name}</span>
      <span class="row-meta">${it.meta}</span>
      ${it.visKey ? `<button class="row-eye" title="Toggle visibility">${isHidden ? '✕' : '◉'}</button>` : ''}
    `;
    row.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('row-eye') && it.visKey) {
        ev.stopPropagation();
        workbench.visibility[it.visKey] = !workbench.visibility[it.visKey];
        ApplyVisibilityState();
        RenderOutliner();
        return;
      }
      workbench.selectedOutlinerId = it.id;
      SelectInspectorPane(it.pane);
      RenderOutliner();
    });
    container.appendChild(row);
  }
}

function ApplyVisibilityState() {
  if (runtime.barkMesh) runtime.barkMesh.visible = workbench.visibility.bark;
  if (runtime.leafMesh) runtime.leafMesh.visible = workbench.visibility.foliage;
  workbench.showSdfGizmos = workbench.visibility.sdf;
  document.getElementById('ToggleSdfGizmos').checked = workbench.showSdfGizmos;
  if (runtime.sdfGizmoGroup) runtime.sdfGizmoGroup.visible = workbench.showSdfGizmos || workbench.renderMode === 'sdf';
  workbench.showWindArrows = workbench.visibility.wind;
  document.getElementById('ToggleWindArrows').checked = workbench.showWindArrows;
  if (runtime.windArrowGroup) runtime.windArrowGroup.visible = workbench.showWindArrows || workbench.renderMode === 'wind';
  if (runtime.forestGroup) runtime.forestGroup.visible = workbench.visibility.forest;
}

function SelectInspectorPane(paneId) {
  document.querySelectorAll('#InspectorTabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.pane === paneId);
  });
  document.querySelectorAll('.insp-pane').forEach((p) => {
    p.classList.toggle('active', p.id === `Pane-${paneId}`);
  });
  const titles = {
    botany: ['Botanical Specimen', 'Weber-Penn'],
    wind: ['Unified WindField', '1 Shared Field'],
    cluster: ['LOD Cluster · UV', '128-Tri VisBuf'],
    fracture: ['Voronoi Fracture', 'Rigid Debris'],
    sdf: ['Analytical SDF · GDF', 'Wind-Synced'],
  };
  const [title, badge] = titles[paneId] || titles.botany;
  document.getElementById('InspectorTitle').textContent = title;
  document.getElementById('InspectorBadge').textContent = badge;
}

function UpdateTelemetryUI() {
  const sp = runtime.specimen;
  const barkC = runtime.clusteredBark?.clusterCount || 0;
  const leafC = runtime.clusteredFoliage?.clusterCount || 0;
  const totalC = barkC + leafC;
  const barkT = runtime.clusteredBark?.triangleCount || 0;
  const leafT = runtime.clusteredFoliage?.triangleCount || 0;
  const sdfC = (sp?.sdfCapsules.length || 0) + (sp?.sdfCanopyLobes.length || 0);

  document.getElementById('NotchSpeciesLabel').textContent = workbench.presetName;
  document.getElementById('StatInstances').textContent = workbench.forestCount.toLocaleString();
  document.getElementById('StatClusters').textContent = totalC.toLocaleString();
  document.getElementById('StatSdfProxies').textContent = String(sdfC);
  document.getElementById('VpFooterTris').textContent = (barkT + leafT).toLocaleString();
  document.getElementById('VpFooterClusters').textContent = totalC.toLocaleString();
  document.getElementById('VpFooterLeaves').textContent = (sp?.leafCount || 0).toLocaleString();
  document.getElementById('VpFooterForest').textContent = workbench.forestCount.toLocaleString();
  document.getElementById('VpFooterGenMs').textContent = `${(sp?.generationMs || 0).toFixed(1)} ms`;
  document.getElementById('FooterDrawCalls').textContent = String(workbench.forestCount > 1 ? 6 : 4);

  document.getElementById('MetricBarkClusters').textContent = String(barkC);
  document.getElementById('MetricLeafClusters').textContent = String(leafC);
  document.getElementById('MetricBarkTris').textContent = barkT.toLocaleString();
  document.getElementById('MetricLeafTris').textContent = leafT.toLocaleString();
  document.getElementById('MetricCapsules').textContent = String(sp?.sdfCapsules.length || 0);
  document.getElementById('MetricLobes').textContent = String(sp?.sdfCanopyLobes.length || 0);
  document.getElementById('GdfCapsuleTag').textContent = `Capsules: ${sp?.sdfCapsules.length || 0}`;
  document.getElementById('GdfLobeTag').textContent = `Lobes: ${sp?.sdfCanopyLobes.length || 0}`;
  document.getElementById('InspectorFooterSel').innerHTML = `Selected: <b>${workbench.presetName}</b>`;
}

function UpdateRangeFill(input) {
  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  const val = parseFloat(input.value);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${pct.toFixed(1)}%`);
}

function DrawWindCompass() {
  const c = document.getElementById('WindCompassCanvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  const cx = 41, cy = 41, r = 34;
  ctx.clearRect(0, 0, 82, 82);
  ctx.strokeStyle = '#2d2d34';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#666';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, 13);
  ctx.fillText('S', cx, 76);

  const rad = (workbench.wind.directionDeg * Math.PI) / 180.0;
  const mag = Math.min(1.0, workbench.wind.speedMps / 20.0);
  const len = 10 + mag * 22;
  const ex = cx + Math.cos(rad) * len;
  const ey = cy + Math.sin(rad) * len;
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.fillStyle = '#ffb454';
  ctx.beginPath();
  ctx.arc(ex, ey, 4, 0, Math.PI * 2);
  ctx.fill();
}

function SetRenderMode(mode) {
  workbench.renderMode = mode;
  document.querySelectorAll('#RenderModeGroup button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const modeNum = mode === 'clusters' ? 1.0 : mode === 'uv' ? 2.0 : 0.0;
  runtime.sharedUniforms.uRenderMode.value = modeNum;
  if (runtime.sdfGizmoGroup) runtime.sdfGizmoGroup.visible = workbench.showSdfGizmos || mode === 'sdf';
  if (runtime.windArrowGroup) runtime.windArrowGroup.visible = workbench.showWindArrows || mode === 'wind';
  const labels = { pbr: 'OpenPBR', clusters: '128-Tri Clusters', uv: 'UV Checker', sdf: 'Analytical SDF', wind: 'Unified WindField', fracture: 'Fracture' };
  document.getElementById('VpFooterMode').textContent = labels[mode] || mode;
  if (mode === 'fracture') SelectInspectorPane('fracture');
  else if (mode === 'sdf') SelectInspectorPane('sdf');
  else if (mode === 'wind') SelectInspectorPane('wind');
  else if (mode === 'clusters' || mode === 'uv') SelectInspectorPane('cluster');
}

//------------------------------------------------------------------------------------------------------------------------
//                                                 DOM EVENT WIRING
//------------------------------------------------------------------------------------------------------------------------

function PopulateSpeciesSelector() {
  const sel = document.getElementById('SelectSpecies');
  sel.innerHTML = '';
  for (const grp of SpeciesGroups) {
    const og = document.createElement('optgroup');
    og.label = grp.label;
    for (const name of grp.names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  sel.value = workbench.presetName;
}

function SyncSpeciesSlidersToPreset() {
  const p = FindSpeciesPreset(workbench.presetName);
  const grp = SpeciesGroups.find((g) => g.names.includes(p.name));
  document.getElementById('OutSpeciesGroup').textContent = grp ? grp.label : 'Botanical';
  workbench.levelsOverride = null;
  workbench.flareOverride = null;
  workbench.tropismOverride = null;
  const rLv = document.getElementById('RangeLevels');
  rLv.value = String(p.botany.levels);
  document.getElementById('OutLevels').textContent = String(p.botany.levels);
  UpdateRangeFill(rLv);

  const rFl = document.getElementById('RangeFlare');
  rFl.value = String(p.botany.flare);
  document.getElementById('OutFlare').textContent = Number(p.botany.flare).toFixed(2);
  UpdateRangeFill(rFl);

  const rTr = document.getElementById('RangeTropism');
  rTr.value = String(p.botany.attractionUp);
  document.getElementById('OutTropism').textContent = Number(p.botany.attractionUp).toFixed(2);
  UpdateRangeFill(rTr);
}

function InitControls() {
  PopulateSpeciesSelector();
  SyncSpeciesSlidersToPreset();
  document.querySelectorAll('input[type="range"]').forEach(UpdateRangeFill);

  // Top document tabs
  document.querySelectorAll('.document-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.document-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      SelectInspectorPane(tab.dataset.tab);
    });
  });

  // Inspector tabs
  document.querySelectorAll('#InspectorTabs button').forEach((b) => {
    b.addEventListener('click', () => SelectInspectorPane(b.dataset.pane));
  });

  // Render mode switcher
  document.querySelectorAll('#RenderModeGroup button').forEach((b) => {
    b.addEventListener('click', () => SetRenderMode(b.dataset.mode));
  });

  // Forest scale switcher (1 | 64 | 10,240)
  document.querySelectorAll('#ForestScaleGroup button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#ForestScaleGroup button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      workbench.forestCount = parseInt(b.dataset.forest, 10);
      RebuildForestInstances();
      RenderOutliner();
      if (workbench.forestCount > 100) {
        camera.position.set(55, 34, 68);
      } else if (workbench.forestCount > 1) {
        camera.position.set(28, 18, 34);
      } else {
        camera.position.set(16, 11, 20);
      }
    });
  });

  // Leaf shuffle solver mode (0=Analytic, 1=VAT Sheet, 2=Hero XPBD)
  document.querySelectorAll('#LeafModeGroup button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#LeafModeGroup button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      workbench.leafShuffleMode = parseInt(b.dataset.leafmode, 10);
      runtime.sharedUniforms.uLeafShuffleMode.value = workbench.leafShuffleMode;
      const meta = [
        ['Analytic', '10,000+ Forest', '~0.4 ms'],
        ['VAT Sheet', '256-2,000 Mid', '~1.1 ms'],
        ['Hero XPBD', '1-16 Hero Trees', '1.8 ms/hero'],
      ][workbench.leafShuffleMode];
      document.getElementById('FooterLeafMode').textContent = meta[0];
      document.getElementById('LeafModeScope').textContent = meta[1];
      document.getElementById('LeafModeCost').textContent = meta[2];
    });
  });

  // Species dropdown + Prev/Next + Seed
  const sel = document.getElementById('SelectSpecies');
  sel.addEventListener('change', () => {
    workbench.presetName = sel.value;
    SyncSpeciesSlidersToPreset();
    RebuildHeroSpecimen();
  });
  const stepSpecies = (delta) => {
    const idx = SpeciesPresets.findIndex((p) => p.name === workbench.presetName);
    const next = (idx + delta + SpeciesPresets.length) % SpeciesPresets.length;
    workbench.presetName = SpeciesPresets[next].name;
    sel.value = workbench.presetName;
    SyncSpeciesSlidersToPreset();
    RebuildHeroSpecimen();
  };
  document.getElementById('BtnPrevSpecies').addEventListener('click', () => stepSpecies(-1));
  document.getElementById('BtnNextSpecies').addEventListener('click', () => stepSpecies(1));
  const bumpSeed = () => {
    workbench.seed = (workbench.seed * 1664525 + 1013904223) >>> 0;
    RebuildHeroSpecimen();
  };
  document.getElementById('BtnNewSeed').addEventListener('click', bumpSeed);
  document.getElementById('BtnRandomizeSeed').addEventListener('click', bumpSeed);

  // Outliner search & filter chips
  document.getElementById('OutlinerSearchInput').addEventListener('input', (e) => {
    workbench.outlinerQuery = e.target.value;
    RenderOutliner();
  });
  document.querySelectorAll('#OutlinerFilters button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#OutlinerFilters button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      workbench.outlinerFilter = b.dataset.filter;
      RenderOutliner();
    });
  });

  // Morphology sliders
  const bindRange = (id, outId, fmt, onChange) => {
    const el = document.getElementById(id);
    const out = document.getElementById(outId);
    el.addEventListener('input', () => {
      UpdateRangeFill(el);
      const v = parseFloat(el.value);
      out.textContent = fmt(v);
      onChange(v);
    });
  };
  bindRange('RangeScaleMul', 'OutScaleMul', (v) => `${v.toFixed(2)}x`, (v) => { workbench.scaleMul = v; RebuildHeroSpecimen(); });
  bindRange('RangeLevels', 'OutLevels', (v) => `${Math.round(v)}`, (v) => { workbench.levelsOverride = Math.round(v); RebuildHeroSpecimen(); });
  bindRange('RangeLeafScale', 'OutLeafScale', (v) => `${v.toFixed(2)}x`, (v) => { workbench.leafScaleMul = v; RebuildHeroSpecimen(); });
  bindRange('RangeFlare', 'OutFlare', (v) => v.toFixed(2), (v) => { workbench.flareOverride = v; RebuildHeroSpecimen(); });
  bindRange('RangeTropism', 'OutTropism', (v) => v.toFixed(2), (v) => { workbench.tropismOverride = v; RebuildHeroSpecimen(); });

  // Unified WindField sliders
  const syncWindUniforms = () => {
    const rad = (workbench.wind.directionDeg * Math.PI) / 180.0;
    runtime.sharedUniforms.uWindDirXZ.value.set(Math.cos(rad), Math.sin(rad));
    runtime.sharedUniforms.uWindSpeed.value = workbench.wind.speedMps;
    runtime.sharedUniforms.uWindGust.value = workbench.wind.gustStrength;
    runtime.sharedUniforms.uWindFreq.value = workbench.wind.gustFrequencyHz;
    runtime.sharedUniforms.uWindWavelength.value = workbench.wind.wavelengthMeters;
    runtime.sharedUniforms.uWindTurb.value = workbench.wind.turbulence;
    runtime.sharedUniforms.uVortexEnabled.value = workbench.wind.vortexEnabled ? 1.0 : 0.0;
    runtime.sharedUniforms.uTrunkFlex.value = workbench.wind.trunkFlex;
    runtime.sharedUniforms.uLimbFlex.value = workbench.wind.limbFlex;
    runtime.sharedUniforms.uDetailFlex.value = workbench.wind.detailFlex;
    document.getElementById('HudWindReadout').textContent = `${workbench.wind.speedMps.toFixed(1)} m/s · ${Math.round(workbench.wind.directionDeg)}°`;
    DrawWindCompass();
  };
  bindRange('RangeWindDir', 'OutWindDir', (v) => `${Math.round(v)}°`, (v) => { workbench.wind.directionDeg = v; syncWindUniforms(); });
  bindRange('RangeWindSpeed', 'OutWindSpeed', (v) => `${v.toFixed(1)} m/s`, (v) => { workbench.wind.speedMps = v; syncWindUniforms(); RenderOutliner(); });
  bindRange('RangeWindGust', 'OutWindGust', (v) => v.toFixed(2), (v) => { workbench.wind.gustStrength = v; syncWindUniforms(); });
  bindRange('RangeWindFreq', 'OutWindFreq', (v) => `${v.toFixed(2)} Hz`, (v) => { workbench.wind.gustFrequencyHz = v; syncWindUniforms(); });
  bindRange('RangeWindWave', 'OutWindWave', (v) => `${Math.round(v)} m`, (v) => { workbench.wind.wavelengthMeters = v; syncWindUniforms(); });
  bindRange('RangeWindTurb', 'OutWindTurb', (v) => v.toFixed(2), (v) => { workbench.wind.turbulence = v; syncWindUniforms(); });
  bindRange('RangeTrunkFlex', 'OutTrunkFlex', (v) => v.toFixed(2), (v) => { workbench.wind.trunkFlex = v; syncWindUniforms(); });
  bindRange('RangeLimbFlex', 'OutLimbFlex', (v) => v.toFixed(2), (v) => { workbench.wind.limbFlex = v; syncWindUniforms(); });
  bindRange('RangeDetailFlex', 'OutDetailFlex', (v) => v.toFixed(2), (v) => { workbench.wind.detailFlex = v; syncWindUniforms(); });

  document.getElementById('ToggleVortex').addEventListener('change', (e) => {
    workbench.wind.vortexEnabled = e.target.checked;
    syncWindUniforms();
  });
  document.getElementById('ToggleWindArrows').addEventListener('change', (e) => {
    workbench.showWindArrows = e.target.checked;
    workbench.visibility.wind = e.target.checked;
    if (runtime.windArrowGroup) runtime.windArrowGroup.visible = workbench.showWindArrows || workbench.renderMode === 'wind';
    RenderOutliner();
  });

  // Cluster & UV controls
  const lodNames = ['LOD 0 (Hero)', 'LOD 1 (Mid)', 'LOD 2 (Far)', 'LOD 3 (Forest)'];
  bindRange('RangeLodTier', 'OutLodTier', (v) => lodNames[Math.round(v)], (v) => {
    workbench.lodTier = Math.round(v);
    RebuildHeroSpecimen();
  });
  bindRange('RangeUvScale', 'OutUvScale', (v) => `${v.toFixed(2)}x`, (v) => {
    workbench.uvScale = v;
    RebuildHeroSpecimen();
  });
  document.getElementById('ToggleClusterSpheres').addEventListener('change', (e) => {
    workbench.showClusterSpheres = e.target.checked;
    if (runtime.clusterSphereGroup) runtime.clusterSphereGroup.visible = workbench.showClusterSpheres;
  });
  document.getElementById('BtnToggleUvMode').addEventListener('click', () => {
    SetRenderMode(workbench.renderMode === 'uv' ? 'pbr' : 'uv');
  });

  // Fracture controls
  bindRange('RangeCutHeight', 'OutCutHeight', (v) => `${Math.round(v * 100)}%`, (v) => { workbench.cutHeightNorm = v; });
  bindRange('RangeSnapImpulse', 'OutSnapImpulse', (v) => `${v.toFixed(2)}x`, (v) => { workbench.snapImpulse = v; });
  document.getElementById('BtnTriggerFracture').addEventListener('click', TriggerFracture);
  document.getElementById('BtnResetFracture').addEventListener('click', ResetFracture);

  // SDF & GDF controls
  document.getElementById('ToggleSdfGizmos').addEventListener('change', (e) => {
    workbench.showSdfGizmos = e.target.checked;
    workbench.visibility.sdf = e.target.checked;
    if (runtime.sdfGizmoGroup) runtime.sdfGizmoGroup.visible = workbench.showSdfGizmos || workbench.renderMode === 'sdf';
    RenderOutliner();
  });
  document.getElementById('ToggleGdfPanel').addEventListener('change', (e) => {
    workbench.showGdfPanel = e.target.checked;
    document.getElementById('GdfOverlayBox').style.display = workbench.showGdfPanel ? 'flex' : 'none';
  });
  bindRange('RangeSmoothK', 'OutSmoothK', (v) => `${v.toFixed(2)} m`, (v) => { workbench.sdfSmoothK = v; });

  DrawWindCompass();
}

//------------------------------------------------------------------------------------------------------------------------
//                                                    ANIMATION LOOP
//------------------------------------------------------------------------------------------------------------------------

const _tmpVec = new Float32Array(3);
const _upY = new THREE.Vector3(0, 1, 0);
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _dirAB = new THREE.Vector3();
const _midAB = new THREE.Vector3();
const _quat = new THREE.Quaternion();

function ResizeViewport() {
  const wrap = canvas.parentElement;
  const w = Math.max(1, wrap.clientWidth);
  const h = Math.max(1, wrap.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', ResizeViewport);

function TickAnimation(nowMs) {
  requestAnimationFrame(TickAnimation);
  const dt = Math.min(0.05, Math.max(0.001, (nowMs - runtime.lastFrameMs) / 1000.0));
  runtime.lastFrameMs = nowMs;
  runtime.timeSec += dt;
  runtime.sharedUniforms.uTime.value = runtime.timeSec;

  // Smooth FPS counter
  const instFps = 1.0 / dt;
  runtime.fpsSmooth = runtime.fpsSmooth * 0.92 + instFps * 0.08;
  if ((runtime.gdfFrameCounter & 7) === 0) {
    document.getElementById('FooterFps').textContent = String(Math.round(runtime.fpsSmooth));
  }

  // Update wind-deformed Analytical SDF primitives (3D gizmos + live 2D GDF section)
  if (runtime.specimen && (workbench.showGdfPanel || runtime.sdfGizmoGroup?.visible)) {
    const deformed = EvaluateWindDeformedSdfPrimitives(runtime.specimen, runtime.timeSec, workbench.wind);
    if (runtime.sdfGizmoGroup?.visible) {
      for (let i = 0; i < deformed.capsules.length && i < runtime.sdfCapsuleMeshes.length; i++) {
        const c = deformed.capsules[i];
        const m = runtime.sdfCapsuleMeshes[i];
        _vA.set(c.ax, c.ay, c.az);
        _vB.set(c.bx, c.by, c.bz);
        _dirAB.subVectors(_vB, _vA);
        const len = Math.max(0.05, _dirAB.length());
        _midAB.addVectors(_vA, _vB).multiplyScalar(0.5);
        m.position.copy(_midAB);
        _quat.setFromUnitVectors(_upY, _dirAB.normalize());
        m.quaternion.copy(_quat);
        const avgR = (c.rA + c.rB) * 0.5;
        m.scale.set(avgR, len, avgR);
      }
      for (let i = 0; i < deformed.lobes.length && i < runtime.sdfLobeMeshes.length; i++) {
        const l = deformed.lobes[i];
        const m = runtime.sdfLobeMeshes[i];
        m.position.set(l.cx, l.cy, l.cz);
        m.scale.setScalar(l.r);
      }
    }
    if (workbench.showGdfPanel && (runtime.gdfFrameCounter % 3 === 0)) {
      RenderGdfCrossSection(
        document.getElementById('GdfSectionCanvas'),
        deformed,
        runtime.specimen.height,
        workbench.sdfSmoothK
      );
    }
  }

  // Update 3D WindField arrow grid
  if (runtime.windArrowGroup?.visible) {
    for (const ar of runtime.windArrows) {
      SampleUnifiedWind(ar.wx, ar.wy, ar.wz, runtime.timeSec, workbench.wind, _tmpVec);
      const spd = Math.hypot(_tmpVec[0], _tmpVec[1], _tmpVec[2]);
      const len = Math.max(0.3, Math.min(3.6, spd * 0.22));
      ar.group.scale.set(1, 1, len);
      ar.group.lookAt(ar.wx + _tmpVec[0], ar.wy + _tmpVec[1], ar.wz + _tmpVec[2]);
      const heat = Math.min(1.0, spd / 18.0);
      ar.mat.color.setRGB(0.2 + 0.8 * heat, 0.82 - 0.35 * heat, 1.0 - 0.7 * heat);
    }
  }

  // Advance rigid-body fractured crown + splinter debris
  if (runtime.fractureActive && runtime.fractureCrownPivot) {
    const maxTilt = Math.PI * 0.47;
    if (runtime.fractureTilt < maxTilt) {
      const gravityTorque = 2.4 * Math.sin(Math.max(0.14, runtime.fractureTilt)) + 0.08 * workbench.wind.speedMps;
      runtime.fractureVel += gravityTorque * dt;
      runtime.fractureTilt = Math.min(maxTilt, runtime.fractureTilt + runtime.fractureVel * dt);
      if (runtime.fractureTilt >= maxTilt) {
        runtime.fractureVel *= -0.18; // damped impact thud
      }
      runtime.fractureCrownPivot.setRotationFromAxisAngle(runtime.fractureAxis, runtime.fractureTilt);
      document.getElementById('MetricCrownTilt').textContent = `${(runtime.fractureTilt * 180 / Math.PI).toFixed(1)}°`;
    }
    for (const s of runtime.fractureSplinters) {
      if (s.mesh.position.y > 0.05 || s.vel.y > 0) {
        s.vel.y -= 9.81 * dt;
        s.mesh.position.addScaledVector(s.vel, dt);
        s.mesh.rotation.x += s.rotVel.x * dt;
        s.mesh.rotation.y += s.rotVel.y * dt;
        s.mesh.rotation.z += s.rotVel.z * dt;
        if (s.mesh.position.y < 0.05) {
          s.mesh.position.y = 0.05;
          s.vel.y *= -0.25;
          s.vel.x *= 0.65;
          s.vel.z *= 0.65;
          s.rotVel.multiplyScalar(0.5);
        }
      }
    }
  }

  runtime.gdfFrameCounter++;
  controls.update();
  renderer.render(scene, camera);
}

// Boot Workbench
InitControls();
ResizeViewport();
RebuildHeroSpecimen();
requestAnimationFrame(TickAnimation);
