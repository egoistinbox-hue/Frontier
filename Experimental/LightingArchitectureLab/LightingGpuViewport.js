// LightingGpuViewport.js — Live WebGL2 GPU shader engine demonstrating Frontier's
// Unified Photometric Partition Lighting Architecture across all 5 Render Modes.

import { IES_PHI_SAMPLES, IES_PROFILE_COUNT, IES_THETA_SAMPLES } from "./PhotometricGoniometry.js";

const VERTEX_SHADER_SRC = `#version 300 es
precision highp float;
precision highp int;

const vec2 QUAD_VERTS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2( 3.0, -1.0),
  vec2(-1.0,  3.0)
);

out vec2 vUv;

void main() {
  vec2 p = QUAD_VERTS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const BLIT_FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uAccumTex;
uniform float uExposure;
out vec4 fragColor;

vec3 acesFilmicToneMap(vec3 x) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec4 acc = texture(uAccumTex, vUv);
  vec3 col = acc.rgb / max(acc.a, 1.0);
  col *= uExposure;
  col = acesFilmicToneMap(col);
  col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}
`;

const MAIN_FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uTanHalfFov;

uniform sampler2D uLightRegisterTex; // 256 x 16 RGBA32F
uniform sampler2D uIesAtlasTex;      // 128 x 256 R32F
uniform sampler2D uPrevAccumTex;     // Progressive PT accumulation

uniform int uLuminaireCount;
uniform int uPartitionCellCount;
uniform int uRenderEngine;       // 0=MatCap, 1=SDF, 2=OpenPBR, 3=RealTimeGI, 4=PathTracer
uniform int uSchedulerMode;      // 0=PrioritySplit8, 1=PrioritySplit4, 2=BruteAll, 3=FrustumClustered, 4=RestirGhost
uniform int uDebugLens;          // 0=FinalLit, 1=CutHeatmap, 2=IsoluxLux, 3=ShadowsOnly, 4=IndirectGiOnly, 5=SpecularOnly
uniform int uEnvPreset;          // 0=Cyclorama, 1=Forest, 2=RacingGarage
uniform int uMatCapLightBlend;   // 0=PureMatCap, 1=LightAwareMatCap
uniform int uSdfVoxelDefectDemo; // 0=AnalyticalDirect, 1=VoxelGridDefect
uniform int uAccumFrame;
uniform float uTimeSec;
uniform float uExposure;

uniform vec3 uCarPos;
uniform float uCarYaw;
uniform vec3 uPrevCarPos;
uniform float uPrevCarYaw;
uniform float uHeadlampIntensity;
uniform float uHighBeamActive;
uniform float uDrlActive;
uniform float uBrakeActive;
uniform float uTurnSignalActive;
uniform int uEmissivePylonCount;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uEnvSh[9];

const float PI = 3.14159265359;
const float TWO_PI = 6.28318530718;

// -----------------------------------------------------------------------------
// Deterministic low-discrepancy helpers (zero runtime RNG entropy)
// -----------------------------------------------------------------------------
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 r2Sequence(int idx, vec2 shift) {
  float a1 = 0.7548776662466927;
  float a2 = 0.5698402909980532;
  return fract(shift + vec2(a1, a2) * float(idx + 1));
}

// -----------------------------------------------------------------------------
// SDF Primitives & Sculpted GT Automotive Scene
// -----------------------------------------------------------------------------
float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float sdCylinderY(vec3 p, float h, float r) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdCylinderX(vec3 p, float h, float r) {
  vec2 d = abs(vec2(length(p.yz), p.x)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

vec2 rotateXZ(vec2 p, float yaw) {
  float c = cos(yaw);
  float s = sin(yaw);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

// Returns vec2(dist, matId)
vec2 mapVehicle(vec3 worldP, vec3 carPos, float carYaw, out vec3 localOut) {
  vec3 p = worldP - carPos;
  p.xz = rotateXZ(p.xz, -carYaw);
  localOut = p;

  // Quick bounding sphere cull around GT car
  float boundD = length(p - vec3(0.0, 0.72, 0.0)) - 3.2;
  if (boundD > 0.6) {
    return vec2(boundD, 10.0);
  }

  // Lower sculpted chassis wedge (front at +Z)
  vec3 chP = p - vec3(0.0, 0.48, 0.0);
  float wedgeSlope = clamp((p.z + 2.0) / 4.2, 1e-4, 1.0);
  float bodyHeight = mix(0.32, 0.20, pow(wedgeSlope, 1.6));
  float chassis = sdRoundBox(chP, vec3(0.92, bodyHeight, 2.08), 0.14);

  // Flared fenders over 4 wheel arches
  vec3 mirP = vec3(abs(p.x), p.y, p.z);
  float frontFender = sdRoundBox(mirP - vec3(0.79, 0.51, 1.32), vec3(0.18, 0.18, 0.45), 0.11);
  float rearFender = sdRoundBox(mirP - vec3(0.83, 0.54, -1.28), vec3(0.20, 0.21, 0.48), 0.12);
  chassis = smin(chassis, min(frontFender, rearFender), 0.12);

  // Sleek fastback cabin canopy
  vec3 cabP = p - vec3(0.0, 0.88, -0.26);
  cabP.y += max(0.0, cabP.z - 0.1) * 0.25;
  cabP.y += max(0.0, -cabP.z - 0.15) * 0.14;
  float cabin = sdRoundBox(cabP, vec3(0.68, 0.26, 0.96), 0.17);

  // Wheel well subtraction
  vec3 wheelMir = vec3(abs(p.x) - 0.88, p.y - 0.34, abs(p.z) - 1.32);
  float wheelCut = sdCylinderX(wheelMir, 0.22, 0.41);
  float body = smin(chassis, cabin, 0.14);
  body = max(body, -wheelCut);

  // Rear carbon wing
  float wingBlade = sdRoundBox(p - vec3(0.0, 0.99, -2.02), vec3(0.86, 0.025, 0.16), 0.012);
  float wingPosts = sdBox(vec3(abs(p.x) - 0.44, p.y - 0.85, p.z + 1.96), vec3(0.03, 0.14, 0.07));
  float carPaint = min(body, min(wingBlade, wingPosts));

  float bestD = carPaint;
  float bestM = 10.0;

  // Smoked glass canopy zone (windshield + side glass mask)
  float glassD = sdRoundBox(p - vec3(0.0, 0.92, -0.20), vec3(0.62, 0.21, 0.82), 0.12);
  if (glassD > body - 0.02 && p.y > 0.72 && abs(p.x) < 0.72 && p.z > -1.35 && p.z < 0.78) {
    // Keep glass surface slightly inset/flush on upper cabin
    float cabinShell = max(cabin, -(p.y - 0.74));
    if (cabinShell < bestD + 0.012) {
      bestD = cabinShell;
      bestM = 11.0;
    }
  }

  // Tires & alloy rims
  float tireD = sdCylinderX(wheelMir, 0.14, 0.34);
  if (tireD < bestD) {
    bestD = tireD;
    bestM = 12.0;
  }
  float rimD = sdCylinderX(wheelMir - vec3(0.02, 0.0, 0.0), 0.145, 0.23);
  if (rimD < bestD) {
    bestD = rimD;
    bestM = 13.0;
  }

  // Front LED Headlamp + DRL optical blade
  float headLampD = sdRoundBox(vec3(abs(p.x) - 0.68, p.y - 0.50, p.z - 2.09), vec3(0.18, 0.042, 0.06), 0.016);
  if (headLampD < bestD) {
    bestD = headLampD;
    bestM = 14.0;
  }

  // Rear full-width ruby LED taillight bar
  float tailLampD = sdRoundBox(p - vec3(0.0, 0.61, -2.14), vec3(0.84, 0.034, 0.045), 0.015);
  if (tailLampD < bestD) {
    bestD = tailLampD;
    bestM = 15.0;
  }

  return vec2(bestD, bestM);
}

vec2 mapScene(vec3 p, out vec3 localCarP) {
  vec2 res = mapVehicle(p, uCarPos, uCarYaw, localCarP);

  // Ground Plane (y = 0)
  float floorD = p.y;
  if (floorD < res.x) {
    res = vec2(floorD, 1.0);
  }

  // Environment Architectural Geometry
  if (uEnvPreset == 0) {
    // Lobby 1: Dark Cyclorama Curved Screen (front calibration wall + curved cyclorama backdrop)
    float calWall = sdBox(p - vec3(0.0, 1.9, 7.6), vec3(6.8, 1.9, 0.2));
    if (calWall < res.x) {
      res = vec2(calWall, 2.0);
    }
    // Side cyclorama curved fin at x = -6.8
    float sideWall = sdBox(p - vec3(-6.8, 2.0, 1.0), vec3(0.25, 2.0, 6.8));
    if (sideWall < res.x) {
      res = vec2(sideWall, 2.0);
    }
    // Curved rear cyclorama wall behind car (z = -6.8)
    float rearWall = sdBox(p - vec3(0.0, 2.0, -6.8), vec3(6.8, 2.0, 0.25));
    if (rearWall < res.x) {
      res = vec2(rearWall, 2.0);
    }
  } else if (uEnvPreset == 1) {
    // Lobby 2: Sunlit Forest Stage — dark timber vertical trunks casting natural sun shadows + warm stage screen
    float calWall = sdBox(p - vec3(0.0, 1.7, 7.8), vec3(7.2, 1.7, 0.25));
    if (calWall < res.x) {
      res = vec2(calWall, 2.0);
    }
    // Periodic sculpted forest trunks around perimeter (outside central showcase pad)
    for (int t = 0; t < 6; ++t) {
      float ang = -0.6 + float(t) * 0.55;
      vec3 trunkPos = vec3(cos(ang) * 7.8, 2.5, sin(ang) * 7.2 + 0.5);
      if (abs(trunkPos.x) > 3.0 || trunkPos.z < -2.8) {
        float td = sdCylinderY(p - trunkPos, 2.5, 0.24 + 0.04 * float(t % 2));
        if (td < res.x) {
          res = vec2(td, 7.0);
        }
      }
    }
  } else {
    // Lobby 3: Afternoon Racing Pit & Garage Archway Portal
    float backWall = sdBox(p - vec3(0.0, 2.2, 7.8), vec3(8.5, 2.2, 0.22));
    // Left garage wall with open sunlit archway portal
    float leftWallUpper = sdBox(p - vec3(-6.2, 3.35, 0.5), vec3(0.24, 0.95, 7.5));
    float leftPillarA = sdBox(p - vec3(-6.2, 1.35, -3.5), vec3(0.28, 1.35, 2.0));
    float leftPillarB = sdBox(p - vec3(-6.2, 1.35, 5.2), vec3(0.28, 1.35, 2.1));
    float ceilingBeam = sdBox(p - vec3(0.0, 4.35, 1.2), vec3(7.5, 0.25, 7.5));
    float archD = min(min(backWall, ceilingBeam), min(leftWallUpper, min(leftPillarA, leftPillarB)));
    if (archD < res.x) {
      res = vec2(archD, 2.0);
    }
  }

  // Three PBR Calibration Spheres (x = -2.45)
  float sChrome = length(p - vec3(-2.55, 0.46, 2.4)) - 0.46;
  if (sChrome < res.x) res = vec2(sChrome, 3.0);

  float sOrange = length(p - vec3(-2.55, 0.46, 1.0)) - 0.46;
  if (sOrange < res.x) res = vec2(sOrange, 4.0);

  float sMatte = length(p - vec3(-2.55, 0.46, -0.4)) - 0.46;
  if (sMatte < res.x) res = vec2(sMatte, 5.0);

  // Overhead Softbox Housing (y = 3.85)
  float softboxMesh = sdBox(p - vec3(0.2, 3.88, 0.2), vec3(1.85, 0.04, 0.85));
  if (softboxMesh < res.x) res = vec2(softboxMesh, 6.0);

  // Emissive Light Pylon ring (only visible physical capsules matching LightTree luminaires!)
  for (int i = 0; i < 48; ++i) {
    if (i >= uEmissivePylonCount) break;
    float fi = float(i);
    float ringIdx = floor(fi / 16.0);
    float ang = (fi / float(max(uEmissivePylonCount, 1))) * TWO_PI * (1.0 + ringIdx * 0.5) + 0.35;
    float rad = 4.2 + ringIdx * 1.45;
    vec3 pylonPos = vec3(cos(ang) * rad, 0.32 + 0.14 * sin(fi * 1.7), sin(ang) * rad + 0.6);
    float pylonD = sdBox(p - pylonPos, vec3(0.065, 0.28, 0.065));
    if (pylonD < res.x) {
      res = vec2(pylonD, 20.0 + fi);
    }
  }

  return res;
}

float mapDistanceOnly(vec3 p) {
  vec3 dummy;
  return mapScene(p, dummy).x;
}

vec3 calcNormal(vec3 p) {
  const vec2 e = vec2(0.0022, -0.0022);
  return normalize(
    e.xyy * mapDistanceOnly(p + e.xyy) +
    e.yyx * mapDistanceOnly(p + e.yyx) +
    e.yxy * mapDistanceOnly(p + e.yxy) +
    e.xxx * mapDistanceOnly(p + e.xxx)
  );
}

// -----------------------------------------------------------------------------
// Visibility Operators: BVH-style Crisp Ray-Marched vs SDF Soft Cone + AO
// -----------------------------------------------------------------------------
float traceExactShadow(vec3 ro, vec3 rd, float maxT, float bias) {
  float t = max(bias, 0.035);
  float minRes = 1.0;
  for (int i = 0; i < 36; ++i) {
    float h = mapDistanceOnly(ro + rd * t);
    if (h < 0.0025) return 0.0;
    minRes = min(minRes, 18.0 * h / t);
    t += clamp(h, 0.035, 0.55);
    if (t >= maxT) break;
  }
  return clamp(minRes, 0.0, 1.0);
}

// GDF Soft-Cone SDF Shadow (Engine 2: GtxLowEnd — 8-12 cheap SDF steps!)
float traceGdfConeShadow(vec3 ro, vec3 rd, float maxT, float coneSoftness) {
  float t = 0.055;
  float res = 1.0;
  for (int i = 0; i < 14; ++i) {
    float h = mapDistanceOnly(ro + rd * t);
    if (h < 0.002) return 0.0;
    res = min(res, coneSoftness * h / t);
    t += clamp(h * 1.15, 0.08, 0.75);
    if (t >= maxT) break;
  }
  return clamp(res * res * (3.0 - 2.0 * res), 0.0, 1.0);
}

float calcSdfAmbientOcclusion(vec3 pos, vec3 nor) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; ++i) {
    float h = 0.03 + 0.14 * float(i);
    float d = mapDistanceOnly(pos + h * nor);
    occ += (h - d) * sca;
    sca *= 0.72;
  }
  return clamp(1.0 - 1.6 * occ, 0.18, 1.0);
}

// -----------------------------------------------------------------------------
// GPU Register Fetches & 128x32 Bilinear Type-C .ies Sampler
// -----------------------------------------------------------------------------
void fetchLuminaire(int idx, out vec4 t0, out vec4 t1, out vec4 t2, out vec4 t3) {
  int base = idx * 4;
  t0 = texelFetch(uLightRegisterTex, ivec2((base + 0) % 256, (base + 0) / 256), 0);
  t1 = texelFetch(uLightRegisterTex, ivec2((base + 1) % 256, (base + 1) / 256), 0);
  t2 = texelFetch(uLightRegisterTex, ivec2((base + 2) % 256, (base + 2) / 256), 0);
  t3 = texelFetch(uLightRegisterTex, ivec2((base + 3) % 256, (base + 3) / 256), 0);
}

void fetchPartitionCell(int cellIdx, out vec4 n0, out vec4 n1, out vec4 n2, out vec4 n3) {
  int base = 512 + cellIdx * 4;
  n0 = texelFetch(uLightRegisterTex, ivec2((base + 0) % 256, (base + 0) / 256), 0);
  n1 = texelFetch(uLightRegisterTex, ivec2((base + 1) % 256, (base + 1) / 256), 0);
  n2 = texelFetch(uLightRegisterTex, ivec2((base + 2) % 256, (base + 2) / 256), 0);
  n3 = texelFetch(uLightRegisterTex, ivec2((base + 3) % 256, (base + 3) / 256), 0);
}

float sampleIesAtlas128x32(int profileOrd, vec3 dirFromLight, vec3 beamAxis, vec3 zeroAzimuth) {
  float cosTheta = clamp(dot(dirFromLight, beamAxis), -0.99999, 0.99999);
  float theta = acos(cosTheta);
  float thetaF = (theta / PI) * float(128 - 1);
  int t0 = clamp(int(floor(thetaF)), 0, 126);
  int t1 = t0 + 1;
  float tf = thetaF - float(t0);

  vec3 orthoCand = abs(dot(zeroAzimuth, beamAxis)) < 0.98 ? zeroAzimuth : vec3(0.0, 0.0, 1.0);
  vec3 right = normalize(orthoCand - beamAxis * dot(orthoCand, beamAxis));
  vec3 up = normalize(cross(beamAxis, right));
  float rx = dot(dirFromLight, right);
  float ry = dot(dirFromLight, up);
  float phi = (abs(rx) + abs(ry) < 1e-5) ? 0.0 : atan(ry, rx);
  if (phi < 0.0) phi += TWO_PI;

  float phiF = (phi / TWO_PI) * 32.0;
  int p0 = int(floor(phiF)) % 32;
  int p1 = (p0 + 1) % 32;
  float pf = phiF - float(int(floor(phiF)));

  int rowBase = clamp(profileOrd, 0, 7) * 32;
  float v00 = texelFetch(uIesAtlasTex, ivec2(t0, rowBase + p0), 0).r;
  float v10 = texelFetch(uIesAtlasTex, ivec2(t1, rowBase + p0), 0).r;
  float v01 = texelFetch(uIesAtlasTex, ivec2(t0, rowBase + p1), 0).r;
  float v11 = texelFetch(uIesAtlasTex, ivec2(t1, rowBase + p1), 0).r;

  return mix(mix(v00, v10, tf), mix(v01, v11, tf), pf);
}

// -----------------------------------------------------------------------------
// Analytical PBR & Luminaire Equations (Identical across all Render Engines!)
// -----------------------------------------------------------------------------
float ggxNdf(float nDotH, float rough) {
  float a = max(rough * rough, 0.002);
  float a2 = a * a;
  float d = (nDotH * nDotH) * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-6);
}

float smithGeometry(float nDotV, float nDotL, float rough) {
  float r = rough + 1.0;
  float k = (r * r) * 0.125;
  float gV = nDotV / (nDotV * (1.0 - k) + k);
  float gL = nDotL / (nDotL * (1.0 - k) + k);
  return gV * gL;
}

vec3 fresnelSchlick(float cosTheta, vec3 f0) {
  return f0 + (1.0 - f0) * pow(max(1.0 - cosTheta, 1e-5), 5.0);
}

vec3 evalOpenPbrBrdf(
  vec3 N, vec3 V, vec3 L,
  vec3 albedo, float metallic, float rough, float clearcoat, float clearcoatRough,
  float specScale, vec3 specDirOverride
) {
  float nDotL = max(dot(N, L), 0.0);
  if (nDotL <= 0.0) return vec3(0.0);
  float nDotV = max(dot(N, V), 1e-4);

  vec3 diffColor = albedo * (1.0 - metallic) / PI;

  vec3 Ls = normalize(specDirOverride);
  float nDotLs = max(dot(N, Ls), 0.0);
  vec3 H = normalize(V + Ls);
  float nDotH = max(dot(N, H), 0.0);
  float vDotH = max(dot(V, H), 0.0);

  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 F = fresnelSchlick(vDotH, f0);
  float D = ggxNdf(nDotH, rough);
  float G = smithGeometry(nDotV, nDotLs, rough);
  vec3 baseSpec = (D * G * F) / max(4.0 * nDotV * nDotLs, 1e-4);

  // Automotive Clearcoat dielectric top layer
  vec3 coatSpec = vec3(0.0);
  float coatAtten = 1.0;
  if (clearcoat > 0.01 && uSdfVoxelDefectDemo == 0) {
    float Dc = ggxNdf(nDotH, clearcoatRough);
    float Gc = smithGeometry(nDotV, nDotLs, clearcoatRough);
    float Fc = fresnelSchlick(vDotH, vec3(0.04)).r * clearcoat;
    coatSpec = vec3(Dc * Gc * Fc) / max(4.0 * nDotV * nDotLs, 1e-4);
    coatAtten = 1.0 - Fc * 0.65;
  }

  return diffColor * (1.0 - F) * coatAtten * nDotL + (baseSpec * coatAtten + coatSpec) * nDotLs * specScale;
}

float smoothRangeWindow(float dist, float rangeMeters) {
  float d2 = dist * dist;
  float r2 = max(rangeMeters * rangeMeters, 0.25);
  float ratio = clamp(1.0 - (d2 / r2) * (d2 / r2), 0.0, 1.0);
  return ratio * ratio;
}

// Clipped Spherical-Polygon Quad Irradiance + Karis Representative Specular Point
vec3 evalAreaQuadAnalytical(
  vec3 P, vec3 N, vec3 V,
  vec4 t0, vec4 t1, vec4 t2, vec4 t3,
  vec3 albedo, float metallic, float rough, float clearcoat,
  out vec3 outShadowDir, out float outShadowDist, out float outIrradOnly
) {
  vec3 center = t0.xyz;
  float halfW = t0.w;
  vec3 upAxis = normalize(t1.xyz);
  float halfH = t1.w;
  vec3 rightAxis = normalize(t2.xyz);
  vec3 emitN = normalize(cross(rightAxis, upAxis));
  vec3 col = t3.rgb;
  bool twoSided = t3.w >= 50.0;
  float collimation = mod(t3.w, 50.0);

  vec3 toCenter = center - P;
  if (!twoSided && dot(emitN, -toCenter) <= 0.0) {
    outShadowDir = vec3(0.0, 1.0, 0.0);
    outShadowDist = 0.0;
    outIrradOnly = 0.0;
    return vec3(0.0);
  }

  // 4 quad corners in world space
  vec3 uVec = rightAxis * halfW;
  vec3 vVec = upAxis * halfH;
  vec3 p0 = center - uVec - vVec - P;
  vec3 p1 = center + uVec - vVec - P;
  vec3 p2 = center + uVec + vVec - P;
  vec3 p3 = center - uVec + vVec - P;

  vec3 v0 = normalize(p0);
  vec3 v1 = normalize(p1);
  vec3 v2 = normalize(p2);
  vec3 v3 = normalize(p3);

  // Spherical polygon vector irradiance (Arvo 1995 / Baum 1989)
  float f01 = acos(clamp(dot(v0, v1), -0.9999, 0.9999));
  float f12 = acos(clamp(dot(v1, v2), -0.9999, 0.9999));
  float f23 = acos(clamp(dot(v2, v3), -0.9999, 0.9999));
  float f30 = acos(clamp(dot(v3, v0), -0.9999, 0.9999));

  vec3 c01 = cross(v0, v1); float l01 = length(c01);
  vec3 c12 = cross(v1, v2); float l12 = length(c12);
  vec3 c23 = cross(v2, v3); float l23 = length(c23);
  vec3 c30 = cross(v3, v0); float l30 = length(c30);

  vec3 vecIrr =
    (l01 > 1e-5 ? c01 / l01 : vec3(0.0)) * f01 +
    (l12 > 1e-5 ? c12 / l12 : vec3(0.0)) * f12 +
    (l23 > 1e-5 ? c23 / l23 : vec3(0.0)) * f23 +
    (l30 > 1e-5 ? c30 / l30 : vec3(0.0)) * f30;

  float irradFactor = abs(dot(vecIrr, N)) * (0.5 / PI);
  float dist = length(toCenter);
  vec3 L = toCenter / max(dist, 1e-4);
  if (collimation > 0.1) {
    float coneDot = max(dot(emitN, -L), 1e-4);
    irradFactor *= pow(coneDot, collimation);
  }

  // Karis Representative Point for sharp LTC-like rectangular softbox reflection
  vec3 R = reflect(-V, N);
  float rDotEn = dot(R, emitN);
  vec3 repPos = center;
  if (abs(rDotEn) > 1e-4) {
    float tPlane = dot(center - P, emitN) / rDotEn;
    if (tPlane > 0.0) {
      vec3 hit = P + R * tPlane;
      vec3 delta = hit - center;
      float px = clamp(dot(delta, rightAxis), -halfW, halfW);
      float py = clamp(dot(delta, upAxis), -halfH, halfH);
      repPos = center + rightAxis * px + upAxis * py;
    }
  }
  vec3 Lspec = normalize(repPos - P);
  float area = 4.0 * halfW * halfH;
  float areaSolid = area / max(dist * dist + area, 0.08);

  outShadowDir = L;
  outShadowDist = dist;
  outIrradOnly = irradFactor * max(col.r, max(col.g, col.b));

  vec3 diffTerm = (albedo * (1.0 - metallic)) * irradFactor;
  // Specular energy-conserving normalization
  float specRough = clamp(rough + sqrt(areaSolid) * 0.18, 0.04, 1.0);
  vec3 specOnly = evalOpenPbrBrdf(N, V, Lspec, albedo, metallic, specRough, clearcoat, 0.045, areaSolid * 2.4, Lspec);
  vec3 fZero = albedo * (1.0 - metallic) / PI * max(dot(N, Lspec), 0.0);
  vec3 pureSpec = max(specOnly - fZero, vec3(0.0));

  if (uDebugLens == 5) return pureSpec * col;
  return (diffTerm + pureSpec) * col;
}

// Analytical Linear Capsule / Tube Light (DRL LED Bar, Ruby Tail Bar, Overhead Strip)
vec3 evalTubeCapsuleAnalytical(
  vec3 P, vec3 N, vec3 V,
  vec4 t0, vec4 t1, vec4 t3,
  vec3 albedo, float metallic, float rough, float clearcoat,
  out vec3 outShadowDir, out float outShadowDist, out float outIrradOnly
) {
  vec3 segA = t0.xyz;
  float radius = max(t0.w, 0.015);
  vec3 segB = t1.xyz;
  float rangeMeters = max(t1.w, 1.0);
  vec3 col = t3.rgb;

  vec3 ab = segB - segA;
  float abLen2 = max(dot(ab, ab), 1e-6);
  float tClosest = clamp(dot(P - segA, ab) / abLen2, 0.0, 1.0);
  vec3 closestPt = segA + ab * tClosest;

  vec3 toLight = closestPt - P;
  float dist = length(toLight);
  vec3 L = toLight / max(dist, 1e-4);

  // Representative reflection point along capsule segment (Karis 2013)
  vec3 R = reflect(-V, N);
  vec3 L0 = segA - P;
  vec3 L1 = segB - P;
  vec3 Ld = L1 - L0;
  float rDotLd = dot(R, Ld);
  float tSpec = clamp((dot(R, L0) * rDotLd - dot(L0, Ld)) / max(dot(Ld, Ld) - rDotLd * rDotLd, 1e-5), 0.0, 1.0);
  vec3 specPt = mix(segA, segB, tSpec);
  vec3 Lspec = normalize(specPt - P);

  float atten = smoothRangeWindow(dist, rangeMeters) / max(dist * dist + radius * radius, 0.04);
  float segLen = sqrt(abLen2);
  float capsuleNorm = min(1.8, 0.45 + segLen * 0.55);

  outShadowDir = L;
  outShadowDist = dist;
  outIrradOnly = max(dot(N, L), 0.0) * atten * capsuleNorm * max(col.r, max(col.g, col.b));

  vec3 brdf = evalOpenPbrBrdf(N, V, L, albedo, metallic, rough, clearcoat, 0.05, 1.0, Lspec);
  if (uDebugLens == 5) {
    vec3 pureDiff = albedo * (1.0 - metallic) / PI * max(dot(N, L), 0.0);
    return max(brdf - pureDiff, vec3(0.0)) * col * atten * capsuleNorm;
  }
  return brdf * col * atten * capsuleNorm;
}

// Unified Single-Luminaire Evaluation (Works for Point, IES, AreaQuad, Tube, SelfLit)
vec3 evalUnifiedLuminaire(
  int lumIdx, vec3 P, vec3 N, vec3 V,
  vec3 albedo, float metallic, float rough, float clearcoat,
  bool doShadow, bool fastSdfShadow,
  out float outLuxContribution
) {
  vec4 t0, t1, t2, t3;
  fetchLuminaire(lumIdx, t0, t1, t2, t3);
  int cat = int(floor(t2.w + 0.5));

  vec3 shadowDir = vec3(0.0, 1.0, 0.0);
  float shadowDist = 0.0;
  float irradContrib = 0.0;
  vec3 radiance = vec3(0.0);

  if (cat == 2 || cat == 4) {
    radiance = evalAreaQuadAnalytical(P, N, V, t0, t1, t2, t3, albedo, metallic, rough, clearcoat, shadowDir, shadowDist, irradContrib);
  } else if (cat == 3) {
    radiance = evalTubeCapsuleAnalytical(P, N, V, t0, t1, t3, albedo, metallic, rough, clearcoat, shadowDir, shadowDist, irradContrib);
  } else {
    // POINT_SPHERE (0) or PHOTOMETRIC_IES (1)
    vec3 lPos = t0.xyz;
    float rangeM = max(t0.w, 1.0);
    vec3 beamAxis = normalize(t1.xyz);
    float radius = max(t1.w, 0.02);
    vec3 zeroAz = t2.xyz;
    vec3 col = t3.rgb;
    int profileOrd = int(floor(t3.w + 0.5));

    vec3 toL = lPos - P;
    float dist = length(toL);
    vec3 L = toL / max(dist, 1e-4);

    float iesWeight = 1.0;
    if (cat == 1) {
      iesWeight = sampleIesAtlas128x32(profileOrd, -L, beamAxis, zeroAz);
    }
    float atten = iesWeight * smoothRangeWindow(dist, rangeM) / max(dist * dist + radius * radius * 0.5, 0.04);

    shadowDir = L;
    shadowDist = dist;
    irradContrib = max(dot(N, L), 0.0) * atten * max(col.r, max(col.g, col.b));

    float effRough = clamp(rough + radius / max(2.0 * dist, 0.1), 0.04, 1.0);
    vec3 brdf = evalOpenPbrBrdf(N, V, L, albedo, metallic, effRough, clearcoat, 0.045, 1.0, L);
    if (uDebugLens == 5) {
      vec3 pureDiff = albedo * (1.0 - metallic) / PI * max(dot(N, L), 0.0);
      radiance = max(brdf - pureDiff, vec3(0.0)) * col * atten;
    } else {
      radiance = brdf * col * atten;
    }
  }

  float vis = 1.0;
  if (doShadow && shadowDist > 0.08 && max(radiance.r, max(radiance.g, radiance.b)) > 0.002) {
    if (fastSdfShadow) {
      vis = traceGdfConeShadow(P + N * 0.02, shadowDir, min(shadowDist - 0.14, 14.0), 9.0);
    } else {
      vis = traceExactShadow(P + N * 0.02, shadowDir, min(shadowDist - 0.14, 16.0), 0.04);
    }
  }

  outLuxContribution = irradContrib * vis;
  return radiance * vis;
}

// -----------------------------------------------------------------------------
// Conty Estevez & Kulla Partition Importance Metric
// -----------------------------------------------------------------------------
float partitionCellImportance(vec3 P, vec3 N, vec4 n0, vec4 n1, vec4 n2, vec4 n3) {
  float power = n0.w;
  if (power <= 1e-5) return 0.0;

  vec3 minB = n0.xyz;
  vec3 maxB = n1.xyz;
  vec3 center = 0.5 * (minB + maxB);
  vec3 extent = 0.5 * (maxB - minB);
  float radius = length(extent);

  vec3 delta = P - center;
  float dist2 = max(dot(delta, delta), max(radius * radius * 0.25, 0.08));
  float dist = sqrt(dist2);
  vec3 dirFromCluster = delta / dist;

  // Bounded emission cone factor
  vec3 axis = n2.xyz;
  float cosO = n2.w;
  float sinO = n3.x;
  float cutoff = n3.z;

  float thetaU = asin(clamp(radius / max(dist, radius + 1e-4), 0.0, 0.99999));
  float thetaO = acos(clamp(cosO, -0.99999, 0.99999));
  float theta = acos(clamp(dot(axis, dirFromCluster), -0.99999, 0.99999));
  float effTheta = max(0.0, theta - thetaO - thetaU);
  float coneWeight = (effTheta >= cutoff) ? 0.03 : max(0.08, cos(effTheta));

  // Surface normal horizon bound
  float cosNormal = clamp(dot(N, -dirFromCluster) + thetaU, 0.05, 1.0);
  return (power * coneWeight * cosNormal) / dist2;
}

// -----------------------------------------------------------------------------
// Environment Sky & Studio Cove Evaluation
// -----------------------------------------------------------------------------
vec3 evalEnvironmentSky(vec3 dir) {
  float y = dir.y;
  float sunDot = max(dot(dir, uSunDir), 1e-4);
  if (uEnvPreset == 0) {
    // Dark Cyclorama Studio Cove
    float t = clamp(y * 1.4, 0.0, 1.0);
    float coveRing = exp(-pow((y - 0.28) / 0.12, 2.0)) * 0.26;
    return mix(vec3(0.025, 0.028, 0.036), vec3(0.05, 0.068, 0.095), t) + vec3(0.9, 0.94, 1.05) * coveRing;
  } else if (uEnvPreset == 1) {
    // Sunlit Forest Showcase Sky
    float up = max(y, 1e-4);
    vec3 sky = mix(vec3(0.32, 0.44, 0.52), vec3(0.11, 0.28, 0.68), pow(up, 0.65));
    float sunGlow = pow(sunDot, 22.0) * 1.4 + pow(sunDot, 420.0) * 14.0;
    if (y < 0.0) sky = vec3(0.05, 0.08, 0.045);
    return sky + uSunColor * sunGlow;
  } else {
    // Afternoon Racing Pit Stadium Sky
    float up = max(y, 1e-4);
    vec3 sky = mix(vec3(0.55, 0.44, 0.36), vec3(0.15, 0.30, 0.62), pow(up, 0.6));
    float sunGlow = pow(sunDot, 16.0) * 1.6 + pow(sunDot, 360.0) * 16.0;
    if (y < 0.0) sky = vec3(0.08, 0.075, 0.07);
    return sky + uSunColor * sunGlow;
  }
}

vec3 evalEnvironmentHarmonics(vec3 N) {
  float x = N.x, y = N.y, z = N.z;
  vec3 res =
    uEnvSh[0] * 0.282095 +
    uEnvSh[1] * (0.488603 * y) +
    uEnvSh[2] * (0.488603 * z) +
    uEnvSh[3] * (0.488603 * x) +
    uEnvSh[4] * (1.092548 * x * y) +
    uEnvSh[5] * (1.092548 * y * z) +
    uEnvSh[6] * (0.315392 * (3.0 * z * z - 1.0)) +
    uEnvSh[7] * (1.092548 * x * z) +
    uEnvSh[8] * (0.546274 * (x * x - y * y));
  return max(res, vec3(0.0));
}

// -----------------------------------------------------------------------------
// Material Properties
// -----------------------------------------------------------------------------
void evalMaterial(
  float matId, vec3 worldP, vec3 localCarP, vec3 N,
  out vec3 albedo, out float metallic, out float rough, out float clearcoat, out vec3 emissive
) {
  albedo = vec3(0.5);
  metallic = 0.0;
  rough = 0.45;
  clearcoat = 0.0;
  emissive = vec3(0.0);

  if (matId < 1.5) {
    // Ground floor (epoxy concrete grid)
    vec2 g = abs(fract(worldP.xz * 0.5) - 0.5);
    float seam = smoothstep(0.015, 0.032, min(g.x, g.y));
    float speckle = hash12(floor(worldP.xz * 22.0)) * 0.035;
    if (uEnvPreset == 1) {
      albedo = mix(vec3(0.11, 0.13, 0.10), vec3(0.16, 0.17, 0.14), seam) + speckle;
      rough = mix(0.42, 0.28, seam);
    } else if (uEnvPreset == 2) {
      albedo = mix(vec3(0.12, 0.125, 0.135), vec3(0.18, 0.185, 0.19), seam) + speckle;
      rough = mix(0.28, 0.16, seam);
    } else {
      albedo = mix(vec3(0.09, 0.095, 0.105), vec3(0.14, 0.145, 0.155), seam) + speckle;
      rough = mix(0.24, 0.15, seam);
    }
  } else if (matId < 2.5) {
    // Calibration Photometric Screen & Garage Architecture
    albedo = vec3(0.56, 0.57, 0.59);
    // Calibration horizontal horizon ticks on front screen (z > 7.1)
    if (worldP.z > 7.1 && abs(worldP.x) < 5.0) {
      float tickY = smoothstep(0.012, 0.025, abs(fract(worldP.y * 2.0) - 0.5));
      float centerLine = smoothstep(0.015, 0.03, abs(worldP.x));
      albedo *= mix(0.65, 1.0, min(tickY, centerLine));
      albedo = mix(vec3(0.70, 0.71, 0.73), albedo, 0.4);
    }
    rough = 0.78;
  } else if (matId < 3.5) {
    // Chrome sphere
    albedo = vec3(0.92, 0.94, 0.96);
    metallic = 1.0;
    rough = 0.04;
  } else if (matId < 4.5) {
    // Clearcoat Signal Orange sphere
    albedo = vec3(0.84, 0.19, 0.05);
    metallic = 0.18;
    rough = 0.24;
    clearcoat = 1.0;
  } else if (matId < 5.5) {
    // Matte Plaster Sphere
    albedo = vec3(0.76, 0.76, 0.78);
    rough = 0.90;
  } else if (matId < 6.5) {
    // Overhead Softbox physical diffuser
    albedo = vec3(0.18);
    rough = 0.5;
    if (N.y < -0.5) emissive = vec3(11.0, 11.4, 12.2);
  } else if (matId < 7.5) {
    // Forest Timber Trunks
    albedo = vec3(0.15, 0.10, 0.07);
    rough = 0.86;
  } else if (matId < 10.5) {
    // Hero GT Car Metallic Clearcoat Sapphire
    albedo = vec3(0.045, 0.145, 0.34);
    metallic = 0.72;
    rough = 0.22;
    clearcoat = 1.0;
  } else if (matId < 11.5) {
    // Smoked Canopy Glass
    albedo = vec3(0.03, 0.04, 0.055);
    metallic = 0.1;
    rough = 0.035;
    clearcoat = 1.0;
  } else if (matId < 12.5) {
    // Tire Rubber
    albedo = vec3(0.045, 0.046, 0.05);
    rough = 0.76;
  } else if (matId < 13.5) {
    // Forged Alloy Wheel Rim
    albedo = vec3(0.76, 0.78, 0.82);
    metallic = 0.94;
    rough = 0.16;
  } else if (matId < 14.5) {
    // Front Headlamp + DRL Optics
    albedo = vec3(0.85);
    rough = 0.08;
    float turnFlash = (abs(localCarP.x) > 0.76 && uTurnSignalActive > 0.5 && fract(uTimeSec * 2.2) < 0.55) ? 1.0 : 0.0;
    vec3 drlCol = vec3(16.0, 17.5, 20.0) * max(uDrlActive, uHeadlampIntensity);
    vec3 ambCol = vec3(14.0, 6.2, 0.4) * turnFlash;
    emissive = mix(drlCol, ambCol, turnFlash);
  } else if (matId < 15.5) {
    // Ruby Taillight + Brake Blade
    albedo = vec3(0.24, 0.01, 0.01);
    rough = 0.12;
    float brakeBoost = 1.0 + uBrakeActive * 3.8;
    emissive = vec3(9.5, 0.32, 0.18) * brakeBoost;
  } else {
    // Emissive Pylons (matId >= 20)
    int eIdx = int(floor(matId - 20.0 + 0.5));
    float hue = fract(float(eIdx) * 0.27);
    vec3 neon = clamp(abs(fract(hue + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    albedo = neon * 0.4;
    emissive = (neon * 0.85 + vec3(0.15)) * 7.5;
  }
}

// -----------------------------------------------------------------------------
// Unified Direct Lighting Dispatcher across Scheduling Modes
// -----------------------------------------------------------------------------
vec3 shadePointDirect(
  vec3 P, vec3 N, vec3 V,
  vec3 albedo, float metallic, float rough, float clearcoat,
  bool doShadows, bool fastSdfShadow, vec2 fragCoord,
  out int outCutEvals, out float outLuxTotal
) {
  outCutEvals = 0;
  outLuxTotal = 0.0;

  // Voxelized Grid Defect Demo (proves why SDF direct lighting MUST stay analytical!)
  vec3 evalP = P;
  if (uRenderEngine == 1 && uSdfVoxelDefectDemo == 1) {
    evalP = (floor(P / 0.45) + 0.5) * 0.45;
  }

  vec3 total = vec3(0.0);

  // Solar / Stadium Directional Sun (in Forest & Racing Garage)
  if (uEnvPreset >= 1) {
    float sunVis = 1.0;
    if (doShadows && dot(N, uSunDir) > 0.0) {
      sunVis = fastSdfShadow
        ? traceGdfConeShadow(P + N * 0.02, uSunDir, 18.0, 12.0)
        : traceExactShadow(P + N * 0.02, uSunDir, 20.0, 0.04);
    }
    vec3 sunBrdf = evalOpenPbrBrdf(N, V, uSunDir, albedo, metallic, rough, clearcoat, 0.045, 1.0, uSunDir);
    total += sunBrdf * uSunColor * sunVis;
    outLuxTotal += max(dot(N, uSunDir), 0.0) * dot(uSunColor, vec3(0.3, 0.6, 0.1)) * sunVis;
  }

  if (uLuminaireCount <= 0) return total;

  // MatCap Engine (Engine 0): Top-4 bright emitters unshadowed + L2 SH
  if (uRenderEngine == 0) {
    int cap = min(uLuminaireCount, 4);
    for (int i = 0; i < 4; ++i) {
      if (i >= cap) break;
      float lux;
      total += evalUnifiedLuminaire(i, evalP, N, V, albedo, metallic, rough, clearcoat, false, false, lux);
      outCutEvals++;
      outLuxTotal += lux;
    }
    return total;
  }

  // Scheduler 2: Brute-Force Reference
  if (uSchedulerMode == 2) {
    for (int i = 0; i < 128; ++i) {
      if (i >= uLuminaireCount) break;
      float lux;
      // Only cast shadows on primary studio/headlamp lights (first 6) for smooth GPU speed
      bool castSh = doShadows && (i < 7);
      total += evalUnifiedLuminaire(i, evalP, N, V, albedo, metallic, rough, clearcoat, castSh, fastSdfShadow, lux);
      outCutEvals++;
      outLuxTotal += lux;
    }
    return total;
  }

  // Scheduler 3: View-Frustum Clustered Defect Demo
  if (uSchedulerMode == 3) {
    // Emulates camera-frustum clustering flaws: drops behind-camera/off-frustum lights from reflections + harsh cell slot cap!
    float viewDist = dot(P - uCamPos, uCamForward);
    int cellOverflow = 0;
    for (int i = 0; i < 128; ++i) {
      if (i >= uLuminaireCount) break;
      vec4 t0, t1, t2, t3;
      fetchLuminaire(i, t0, t1, t2, t3);
      vec3 lPos = t0.xyz;
      float lViewZ = dot(lPos - uCamPos, uCamForward);
      vec3 toL = normalize(lPos - uCamPos);
      bool inFrustum = lViewZ > 0.2 && abs(dot(toL, uCamRight)) < 0.78;
      if (!inFrustum) continue; // <-- Clustered lighting drops off-frustum softboxes & rear lights from reflections!
      // Quantized cluster cell overflow cap (4 lights max per 2.2m voxel cell)
      if (cellOverflow >= 5 && i > 4) continue;
      cellOverflow++;
      float lux;
      bool castSh = doShadows && (i < 6);
      total += evalUnifiedLuminaire(i, evalP, N, V, albedo, metallic, rough, clearcoat, castSh, fastSdfShadow, lux);
      outCutEvals++;
      outLuxTotal += lux;
    }
    return total;
  }

  // Scheduler 4: ReSTIR DI Temporal Lag / 1-SPP Sparkle Demo
  if (uSchedulerMode == 4) {
    // Evaluate 1 stochastic light candidate at CURRENT frame + blend stale history from uPrevCarPos/Yaw!
    float r = hash12(fragCoord + vec2(float(uAccumFrame) * 17.3, uTimeSec * 60.0));
    int pick = int(floor(r * float(uLuminaireCount)));
    pick = clamp(pick, 0, uLuminaireCount - 1);
    float lux;
    vec3 currSample = evalUnifiedLuminaire(pick, evalP, N, V, albedo, metallic, rough, clearcoat, doShadows, fastSdfShadow, lux) * float(uLuminaireCount) * 0.52;

    // Synthesize ghosting trail from previous vehicle position & delayed shadow rejection
    vec3 ghostDelta = P - uPrevCarPos;
    float ghostLobe = exp(-dot(ghostDelta, ghostDelta) * 0.55) * length(uCarPos - uPrevCarPos) * 14.0;
    vec3 ghostTail = vec3(1.6, 0.14, 0.08) * ghostLobe;
    outCutEvals = 1;
    outLuxTotal = lux * float(uLuminaireCount) * 0.5;
    return currSample + ghostTail;
  }

  // Scheduler 0 & 1: SELECTED Frontier PhotometricLightTree Best-First PriorityCut!
  int targetBudget = (uSchedulerMode == 1 || uRenderEngine == 1) ? 6 : 10;

  // Small fixed priority queue of partition cell indices + importances
  const int QMAX = 14;
  int qCells[QMAX];
  float qScores[QMAX];
  int qSize = 0;

  if (uPartitionCellCount > 0) {
    vec4 rn0, rn1, rn2, rn3;
    fetchPartitionCell(0, rn0, rn1, rn2, rn3);
    qCells[0] = 0;
    qScores[0] = partitionCellImportance(evalP, N, rn0, rn1, rn2, rn3);
    qSize = 1;
  }

  int leafEvals = 0;
  vec3 tailClusterApprox = vec3(0.0);

  for (int iter = 0; iter < 24; ++iter) {
    if (qSize <= 0 || leafEvals >= targetBudget) break;

    // Pop max-score entry
    int bestSlot = 0;
    float bestScore = qScores[0];
    for (int k = 1; k < QMAX; ++k) {
      if (k >= qSize) break;
      if (qScores[k] > bestScore) {
        bestScore = qScores[k];
        bestSlot = k;
      }
    }
    int cellIdx = qCells[bestSlot];
    qSize--;
    qCells[bestSlot] = qCells[qSize];
    qScores[bestSlot] = qScores[qSize];

    vec4 n0, n1, n2, n3;
    fetchPartitionCell(cellIdx, n0, n1, n2, n3);
    int link = int(floor(n1.w + 0.5));

    if (link < 0) {
      // Leaf luminaire!
      int lumIdx = -link - 1;
      if (lumIdx >= 0 && lumIdx < uLuminaireCount) {
        float lux;
        bool castSh = doShadows && (leafEvals < 5 || lumIdx < 6);
        total += evalUnifiedLuminaire(lumIdx, evalP, N, V, albedo, metallic, rough, clearcoat, castSh, fastSdfShadow, lux);
        leafEvals++;
        outLuxTotal += lux;
      }
    } else if (link >= 0 && link + 1 < uPartitionCellCount && qSize + 2 <= QMAX) {
      // Expand both nested adjacent partition entries
      int cLeft = link;
      int cRight = link + 1;
      vec4 ln0, ln1, ln2, ln3;
      fetchPartitionCell(cLeft, ln0, ln1, ln2, ln3);
      qCells[qSize] = cLeft;
      qScores[qSize] = partitionCellImportance(evalP, N, ln0, ln1, ln2, ln3);
      qSize++;

      vec4 rn0, rn1, rn2, rn3;
      fetchPartitionCell(cRight, rn0, rn1, rn2, rn3);
      qCells[qSize] = cRight;
      qScores[qSize] = partitionCellImportance(evalP, N, rn0, rn1, rn2, rn3);
      qSize++;
    }
  }

  // Smooth diffuse residual compensation for remaining lower-importance far clusters!
  for (int r = 0; r < QMAX; ++r) {
    if (r >= qSize) break;
    vec4 n0, n1, n2, n3;
    fetchPartitionCell(qCells[r], n0, n1, n2, n3);
    vec3 cCenter = 0.5 * (n0.xyz + n1.xyz);
    vec3 toC = cCenter - evalP;
    float d2 = max(dot(toC, toC), 1.5);
    vec3 Lc = normalize(toC);
    float diffFactor = max(dot(N, Lc), 0.0) * n0.w / (4.0 * PI * d2);
    tailClusterApprox += (albedo * (1.0 - metallic)) * diffFactor * 0.22;
  }

  outCutEvals = leafEvals;
  return total + tailClusterApprox;
}

// -----------------------------------------------------------------------------
// Multi-Bounce GI / Reflections per Render Engine
// -----------------------------------------------------------------------------
vec3 evalEnvironmentAndIndirectGi(
  vec3 P, vec3 N, vec3 V,
  vec3 albedo, float metallic, float rough, float clearcoat, float ao,
  int engineMode, out vec3 outGiOnly
) {
  outGiOnly = vec3(0.0);
  if (uSdfVoxelDefectDemo == 1 && engineMode == 1) {
    clearcoat = 0.0;
    rough = max(rough, 0.65);
  }

  // Diffuse IBL via baked L2 Spherical Harmonics
  vec3 diffuseIbl = evalEnvironmentHarmonics(N) * (albedo * (1.0 - metallic)) * ao;

  // Specular Sky + Ground Bounce Reflection
  vec3 R = reflect(-V, N);
  vec3 envSpecColor = evalEnvironmentSky(R);
  // Subtle rough blur approximation toward SH2
  vec3 shSpec = evalEnvironmentHarmonics(R);
  vec3 prefilteredSpec = mix(envSpecColor, shSpec, clamp(rough * 1.15, 0.0, 1.0));

  float nDotV = max(dot(N, V), 1e-4);
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 Fspec = fresnelSchlick(nDotV, f0);
  vec3 specIbl = prefilteredSpec * Fspec * ao;

  if (clearcoat > 0.01) {
    float Fc = fresnelSchlick(nDotV, vec3(0.04)).r * clearcoat;
    specIbl = specIbl * (1.0 - Fc * 0.65) + envSpecColor * Fc;
  }

  // Real-Time GI (Engine 3) & Analytical SDF Radiosity (Engine 1):
  // Chromatic indirect color bleed from automotive DRLs, ruby brake blade, sunlit floor & pylons!
  vec3 radiosityBleed = vec3(0.0);
  if (engineMode == 1 || engineMode == 3) {
    float giStrength = (engineMode == 3) ? 1.0 : 0.62;
    // Floor bounce warm-white from overhead softbox & sun
    float floorFacing = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
    float underCarMask = clamp(length(P.xz - uCarPos.xz) * 0.45, 0.35, 1.0);
    vec3 softboxFloorBounce = vec3(0.11, 0.12, 0.13) * exp(-dot(P.xz, P.xz) * 0.08) * floorFacing * underCarMask;
    if (uEnvPreset >= 1) softboxFloorBounce += uSunColor * 0.085 * floorFacing * underCarMask;

    // Chromatic Stokes-like bounce from vehicle Ruby Taillights & DRLs onto nearby floor/car/spheres
    vec3 carF = vec3(sin(uCarYaw), 0.0, cos(uCarYaw));
    vec3 tailPos = uCarPos - carF * 2.2;
    vec3 nosePos = uCarPos + carF * 2.2;
    float dTail2 = dot(P - tailPos, P - tailPos) + 0.45;
    float dNose2 = dot(P - nosePos, P - nosePos) + 0.45;
    vec3 rubyBounce = vec3(0.85, 0.04, 0.02) * (1.0 + uBrakeActive * 2.2) / (dTail2 * 1.9);
    vec3 drlBounce = vec3(0.35, 0.42, 0.55) * max(uDrlActive, uHeadlampIntensity) / (dNose2 * 2.2);

    // Chromatic bounce from adjacent emissive pylons
    vec3 pylonGi = vec3(0.0);
    int samplePylons = min(uEmissivePylonCount, 12);
    for (int i = 0; i < 12; ++i) {
      if (i >= samplePylons) break;
      float fi = float(i * max(uEmissivePylonCount / max(samplePylons, 1), 1));
      float ringIdx = floor(fi / 16.0);
      float ang = (fi / float(max(uEmissivePylonCount, 1))) * TWO_PI * (1.0 + ringIdx * 0.5) + 0.35;
      float rad = 4.2 + ringIdx * 1.45;
      vec3 pp = vec3(cos(ang) * rad, 0.32, sin(ang) * rad + 0.6);
      float dp2 = dot(P - pp, P - pp) + 0.6;
      float hue = fract(fi * 0.27);
      vec3 neon = clamp(abs(fract(hue + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
      pylonGi += neon * 0.48 / (dp2 * 1.4);
    }

    radiosityBleed = (softboxFloorBounce + rubyBounce + drlBounce + pylonGi) * (albedo * (1.0 - metallic)) * giStrength * ao;
  }

  outGiOnly = diffuseIbl + radiosityBleed;
  if (uDebugLens == 5) return specIbl;
  return diffuseIbl + specIbl + radiosityBleed;
}

// -----------------------------------------------------------------------------
// Engine 0: Sculpting MatCap Sphere Shading (+ Optional Light-Aware Blend)
// -----------------------------------------------------------------------------
vec3 evalMatCapSurface(vec3 N, vec3 P, vec3 V, float matId, vec3 albedo, vec3 emissive) {
  vec2 nv = vec2(dot(N, uCamRight), dot(N, uCamUp));
  float len2 = dot(nv, nv);
  float nz = sqrt(max(0.0, 1.0 - min(len2, 1.0)));
  // Rich sculpted automotive clay/ceramic MatCap enclosure curve
  float keyCurve = clamp(dot(normalize(vec3(nv, nz)), normalize(vec3(-0.35, 0.72, 0.6))), 1e-4, 1.0);
  float rimCurve = pow(max(1.0 - nz, 1e-4), 2.6);
  vec3 baseClay = (matId > 9.5 && matId < 10.5) ? vec3(0.22, 0.34, 0.56) : albedo * 0.68 + vec3(0.14);
  vec3 matcap = baseClay * (0.32 + 0.68 * pow(keyCurve, 1.35)) + vec3(0.28, 0.32, 0.38) * rimCurve + vec3(pow(keyCurve, 26.0) * 0.45);

  if (uMatCapLightBlend == 1) {
    int dummyCuts;
    float dummyLux;
    vec3 directFill = shadePointDirect(P, N, V, albedo * 0.5, 0.15, 0.42, 0.35, false, false, gl_FragCoord.xy, dummyCuts, dummyLux);
    vec3 shEnv = evalEnvironmentHarmonics(N) * 0.35;
    matcap = matcap * 0.68 + shEnv + directFill * 0.55;
  }
  return matcap + emissive * 0.5;
}

// -----------------------------------------------------------------------------
// Heatmap & False-Colour Photometric Diagnostic Palettes
// -----------------------------------------------------------------------------
vec3 infernoPalette(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.04, 0.05, 0.16);
  vec3 c1 = vec3(0.32, 0.09, 0.48);
  vec3 c2 = vec3(0.85, 0.25, 0.22);
  vec3 c3 = vec3(0.98, 0.88, 0.25);
  if (t < 0.33) return mix(c0, c1, t / 0.33);
  if (t < 0.66) return mix(c1, c2, (t - 0.33) / 0.33);
  return mix(c2, c3, (t - 0.66) / 0.34);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  float aspect = uResolution.x / max(uResolution.y, 1.0);

  // Subtle deterministic sub-pixel jitter in Progressive Path Tracer mode
  vec2 jitter = vec2(0.0);
  if (uRenderEngine == 4) {
    vec2 shift = vec2(hash12(gl_FragCoord.xy), hash12(gl_FragCoord.xy + 19.7));
    jitter = (r2Sequence(uAccumFrame, shift) - 0.5) / uResolution * 1.4;
  }

  vec3 rd = normalize(
    uCamForward +
    uCamRight * ((ndc.x + jitter.x * 2.0) * aspect * uTanHalfFov) +
    uCamUp * ((ndc.y + jitter.y * 2.0) * uTanHalfFov)
  );
  vec3 ro = uCamPos;

  // Primary Ray March
  float t = 0.05;
  float hitMat = -1.0;
  vec3 hitLocalCar = vec3(0.0);
  for (int i = 0; i < 110; ++i) {
    vec3 p = ro + rd * t;
    vec2 d = mapScene(p, hitLocalCar);
    if (d.x < 0.0018) {
      hitMat = d.y;
      break;
    }
    t += clamp(d.x, 0.01, 1.4);
    if (t > 45.0) break;
  }

  vec3 finalRgb = vec3(0.0);

  if (hitMat < 0.0) {
    finalRgb = evalEnvironmentSky(rd);
    if (uDebugLens == 1 || uDebugLens == 2 || uDebugLens == 4) finalRgb *= 0.25;
  } else {
    vec3 P = ro + rd * t;
    vec3 N = calcNormal(P);
    vec3 V = -rd;

    vec3 albedo, emissive;
    float metallic, rough, clearcoat;
    evalMaterial(hitMat, P, hitLocalCar, N, albedo, metallic, rough, clearcoat, emissive);

    if (uRenderEngine == 0) {
      finalRgb = evalMatCapSurface(N, P, V, hitMat, albedo, emissive);
    } else if (uRenderEngine == 4) {
      // Progressive Deterministic Path Tracer (Sobol / R2 (0,2)) + 1 Bounce Reflections/GI
      int cutEvals;
      float luxTotal;
      vec3 direct = shadePointDirect(P, N, V, albedo, metallic, rough, clearcoat, true, false, gl_FragCoord.xy, cutEvals, luxTotal);
      vec3 rad = direct + emissive;

      // Stochastic secondary ray (specular clearcoat/metal or cosine diffuse bounce)
      vec2 shift = vec2(hash12(gl_FragCoord.xy * 1.37), hash12(gl_FragCoord.xy + 41.3));
      vec2 xi = r2Sequence(uAccumFrame * 3 + 7, shift);

      vec3 ortho1 = normalize(abs(N.y) < 0.99 ? cross(N, vec3(0.0, 1.0, 0.0)) : cross(N, vec3(1.0, 0.0, 0.0)));
      vec3 ortho2 = cross(N, ortho1);

      float specProb = clamp(mix(0.25, 0.92, max(metallic, clearcoat)), 0.15, 0.92);
      vec3 bounceDir;
      vec3 bounceWeight;
      if (xi.x < specProb) {
        vec3 R = reflect(-V, N);
        float effR = clearcoat > 0.5 && xi.y < 0.5 ? 0.045 : rough;
        float phi = xi.y * TWO_PI;
        float rCone = effR * effR * sqrt(xi.x / specProb);
        bounceDir = normalize(R + (ortho1 * cos(phi) + ortho2 * sin(phi)) * rCone);
        float nDotV = max(dot(N, V), 1e-4);
        vec3 F = fresnelSchlick(nDotV, mix(vec3(0.04), albedo, max(metallic, clearcoat * 0.25)));
        bounceWeight = F / specProb;
      } else {
        float phi = xi.y * TWO_PI;
        float u = (xi.x - specProb) / max(1.0 - specProb, 1e-4);
        float cosT = sqrt(1.0 - u);
        float sinT = sqrt(u);
        bounceDir = normalize(ortho1 * cos(phi) * sinT + ortho2 * sin(phi) * sinT + N * cosT);
        bounceWeight = (albedo * (1.0 - metallic)) / (1.0 - specProb);
      }

      // Trace 1 secondary ray cleanly
      float t2 = 0.04;
      float m2 = -1.0;
      vec3 lc2 = vec3(0.0);
      vec3 ro2 = P + N * 0.015;
      for (int s = 0; s < 56; ++s) {
        vec2 d2 = mapScene(ro2 + bounceDir * t2, lc2);
        if (d2.x < 0.004) {
          m2 = d2.y;
          break;
        }
        t2 += clamp(d2.x, 0.02, 1.2);
        if (t2 > 22.0) break;
      }

      if (m2 < 0.0) {
        rad += bounceWeight * evalEnvironmentSky(bounceDir);
      } else {
        vec3 P2 = ro2 + bounceDir * t2;
        vec3 N2 = calcNormal(P2);
        vec3 a2, e2;
        float mt2, r2m, cc2;
        evalMaterial(m2, P2, lc2, N2, a2, mt2, r2m, cc2, e2);
        int c2;
        float lx2;
        vec3 d2Light = shadePointDirect(P2, N2, -bounceDir, a2, mt2, r2m, cc2, true, true, gl_FragCoord.xy + 5.0, c2, lx2);
        rad += bounceWeight * (d2Light + e2 + evalEnvironmentHarmonics(N2) * a2 * 0.35);
      }
      finalRgb = rad;

      if (uDebugLens == 1) finalRgb = infernoPalette(float(cutEvals) / 10.0);
      else if (uDebugLens == 2) finalRgb = infernoPalette(log2(1.0 + luxTotal * 1.4) / 5.5);
    } else {
      // Engines 1 (SDF), 2 (OpenPBR Direct), 3 (RealTime GI)
      bool fastSdf = (uRenderEngine == 1);
      int cutEvals;
      float luxTotal;
      vec3 direct = shadePointDirect(P, N, V, albedo, metallic, rough, clearcoat, true, fastSdf, gl_FragCoord.xy, cutEvals, luxTotal);
      float ao = (uRenderEngine == 1 || uRenderEngine == 3) ? calcSdfAmbientOcclusion(P, N) : 1.0;
      vec3 giOut;
      vec3 envGi = evalEnvironmentAndIndirectGi(P, N, V, albedo, metallic, rough, clearcoat, ao, uRenderEngine, giOut);

      // Specular floor / clearcoat reflection of bright Softbox & Pyres
      if (uDebugLens == 1) {
        finalRgb = infernoPalette(float(cutEvals) / 10.0);
      } else if (uDebugLens == 2) {
        finalRgb = infernoPalette(log2(1.0 + luxTotal * 1.4) / 5.5);
      } else if (uDebugLens == 3) {
        // Shadows & AO Only
        float sunSh = traceGdfConeShadow(P + N * 0.02, normalize(vec3(0.45, 0.85, 0.3)), 14.0, fastSdf ? 8.0 : 28.0);
        finalRgb = vec3(sunSh * ao);
      } else if (uDebugLens == 4) {
        finalRgb = giOut * 2.2;
      } else if (uDebugLens == 5) {
        finalRgb = direct + envGi + emissive * 0.1;
      } else {
        finalRgb = direct + envGi + emissive;
      }
    }
  }

  // Accumulate when in Path Tracer (Engine 4), overwrite when in Real-Time modes
  if (uRenderEngine == 4 && uAccumFrame > 0) {
    vec4 prev = texelFetch(uPrevAccumTex, ivec2(gl_FragCoord.xy), 0);
    fragColor = prev + vec4(min(finalRgb, vec3(32.0)), 1.0);
  } else {
    fragColor = vec4(finalRgb, 1.0);
  }
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`GLSL compile failed: ${info}`);
  }
  return shader;
}

function linkProgram(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}

export class LightingGpuViewport {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      throw new Error("WebGL2 is required for LightingArchitectureLab.");
    }
    this.gl = gl;
    this.floatFboExt = gl.getExtension("EXT_color_buffer_float");
    this.halfFloatFboExt = gl.getExtension("EXT_color_buffer_half_float");

    this.mainProg = linkProgram(gl, VERTEX_SHADER_SRC, MAIN_FRAGMENT_SRC);
    this.blitProg = linkProgram(gl, VERTEX_SHADER_SRC, BLIT_FRAGMENT_SRC);
    this.emptyVao = gl.createVertexArray();

    // Light Register Texture (256 x 16 RGBA32F, NEAREST)
    this.lightRegisterTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lightRegisterTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 16, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // 128 x 256 R32F IES Candela Atlas Texture
    this.iesAtlasTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.iesAtlasTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      IES_THETA_SAMPLES,
      IES_PHI_SAMPLES * IES_PROFILE_COUNT,
      0,
      gl.RED,
      gl.FLOAT,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.accumWidth = 0;
    this.accumHeight = 0;
    this.accumTextures = [null, null];
    this.accumFbos = [null, null];
    this.accumIndex = 0;
    this.accumFrame = 0;

    this.mainUniforms = this._collectUniforms(this.mainProg, [
      "uResolution",
      "uCamPos",
      "uCamRight",
      "uCamUp",
      "uCamForward",
      "uTanHalfFov",
      "uLightRegisterTex",
      "uIesAtlasTex",
      "uPrevAccumTex",
      "uLuminaireCount",
      "uPartitionCellCount",
      "uRenderEngine",
      "uSchedulerMode",
      "uDebugLens",
      "uEnvPreset",
      "uMatCapLightBlend",
      "uSdfVoxelDefectDemo",
      "uAccumFrame",
      "uTimeSec",
      "uExposure",
      "uCarPos",
      "uCarYaw",
      "uPrevCarPos",
      "uPrevCarYaw",
      "uHeadlampIntensity",
      "uHighBeamActive",
      "uDrlActive",
      "uBrakeActive",
      "uTurnSignalActive",
      "uEmissivePylonCount",
      "uSunDir",
      "uSunColor",
      "uEnvSh[0]",
    ]);

    this.blitUniforms = {
      uAccumTex: gl.getUniformLocation(this.blitProg, "uAccumTex"),
      uExposure: gl.getUniformLocation(this.blitProg, "uExposure"),
    };
  }

  _collectUniforms(prog, names) {
    const out = {};
    for (const n of names) {
      out[n] = this.gl.getUniformLocation(prog, n);
    }
    return out;
  }

  uploadIesAtlas(floatArray) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.iesAtlasTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      IES_THETA_SAMPLES,
      IES_PHI_SAMPLES * IES_PROFILE_COUNT,
      gl.RED,
      gl.FLOAT,
      floatArray
    );
  }

  uploadLightRegister(texData) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lightRegisterTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 16, gl.RGBA, gl.FLOAT, texData);
  }

  resetAccumulation() {
    this.accumFrame = 0;
  }

  _ensureAccumTargets(w, h) {
    const gl = this.gl;
    if (this.accumWidth === w && this.accumHeight === h) return;

    this.accumWidth = w;
    this.accumHeight = h;
    this.accumFrame = 0;

    const useFloat = Boolean(this.floatFboExt);
    const useHalf = !useFloat && Boolean(this.halfFloatFboExt);
    const internalFmt = useFloat ? gl.RGBA32F : useHalf ? gl.RGBA16F : gl.RGBA8;
    const texType = useFloat ? gl.FLOAT : useHalf ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    for (let i = 0; i < 2; ++i) {
      if (this.accumTextures[i]) gl.deleteTexture(this.accumTextures[i]);
      if (this.accumFbos[i]) gl.deleteFramebuffer(this.accumFbos[i]);

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, gl.RGBA, texType, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      this.accumTextures[i] = tex;
      this.accumFbos[i] = fbo;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  renderViewport(params) {
    const gl = this.gl;
    const renderScale = params.renderScale || 1.0;
    const w = Math.max(240, Math.floor(this.canvas.clientWidth * renderScale));
    const h = Math.max(160, Math.floor(this.canvas.clientHeight * renderScale));

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    this._ensureAccumTargets(w, h);

    const readIdx = this.accumIndex;
    const writeIdx = 1 - this.accumIndex;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbos[writeIdx]);
    gl.viewport(0, 0, w, h);

    gl.useProgram(this.mainProg);
    gl.bindVertexArray(this.emptyVao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lightRegisterTex);
    gl.uniform1i(this.mainUniforms.uLightRegisterTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.iesAtlasTex);
    gl.uniform1i(this.mainUniforms.uIesAtlasTex, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTextures[readIdx]);
    gl.uniform1i(this.mainUniforms.uPrevAccumTex, 2);

    const u = this.mainUniforms;
    gl.uniform2f(u.uResolution, w, h);
    gl.uniform3fv(u.uCamPos, params.camPos);
    gl.uniform3fv(u.uCamRight, params.camRight);
    gl.uniform3fv(u.uCamUp, params.camUp);
    gl.uniform3fv(u.uCamForward, params.camForward);
    gl.uniform1f(u.uTanHalfFov, params.tanHalfFov);

    gl.uniform1i(u.uLuminaireCount, params.luminaireCount);
    gl.uniform1i(u.uPartitionCellCount, params.partitionCellCount);
    gl.uniform1i(u.uRenderEngine, params.renderEngine);
    gl.uniform1i(u.uSchedulerMode, params.schedulerMode);
    gl.uniform1i(u.uDebugLens, params.debugLens);
    gl.uniform1i(u.uEnvPreset, params.envPreset);
    gl.uniform1i(u.uMatCapLightBlend, params.matCapLightBlend ? 1 : 0);
    gl.uniform1i(u.uSdfVoxelDefectDemo, params.sdfVoxelDefectDemo ? 1 : 0);
    gl.uniform1i(u.uAccumFrame, this.accumFrame);
    gl.uniform1f(u.uTimeSec, params.timeSec);
    gl.uniform1f(u.uExposure, params.exposure);

    gl.uniform3fv(u.uCarPos, params.carPos);
    gl.uniform1f(u.uCarYaw, params.carYaw);
    gl.uniform3fv(u.uPrevCarPos, params.prevCarPos);
    gl.uniform1f(u.uPrevCarYaw, params.prevCarYaw);
    gl.uniform1f(u.uHeadlampIntensity, params.headlampIntensity);
    gl.uniform1f(u.uHighBeamActive, params.highBeamActive ? 1.0 : 0.0);
    gl.uniform1f(u.uDrlActive, params.drlActive ? 1.0 : 0.0);
    gl.uniform1f(u.uBrakeActive, params.brakeActive ? 1.0 : 0.0);
    gl.uniform1f(u.uTurnSignalActive, params.turnSignalActive ? 1.0 : 0.0);
    gl.uniform1i(u.uEmissivePylonCount, params.emissivePylonCount);

    gl.uniform3fv(u.uSunDir, params.sunDir);
    gl.uniform3fv(u.uSunColor, params.sunColor);
    gl.uniform3fv(u["uEnvSh[0]"], params.envSh);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Tone-mapped blit to default canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTextures[writeIdx]);
    gl.uniform1i(this.blitUniforms.uAccumTex, 0);
    gl.uniform1f(this.blitUniforms.uExposure, params.exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.accumIndex = writeIdx;
    if (params.renderEngine === 4) {
      this.accumFrame = Math.min(this.accumFrame + 1, 256);
    } else {
      this.accumFrame = 0;
    }
  }
}
