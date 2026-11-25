// LightingGpuViewport.js — Modular fast-compiling WebGL2 GPU shader engine
// (splits Real-Time Multi-Mode program and Progressive Path-Tracer program to keep
// ANGLE/D3D11/Metal shader link times under ~50 ms and avoid GPU watchdog timeouts).

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
  vec3 col = max(acc.rgb, vec3(0.0)) / max(acc.a, 1.0);
  col *= uExposure;
  col = acesFilmicToneMap(col);
  col = pow(max(col, vec3(1e-5)), vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}
`;

// Shared lean GLSL core (O(1) analytic pylon rings + single luminaire eval site)
const SHARED_GLSL_COMMON = `#version 300 es
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

uniform sampler2D uLightRegisterTex;
uniform sampler2D uIesAtlasTex;
uniform sampler2D uPrevAccumTex;

uniform int uLuminaireCount;
uniform int uPartitionCellCount;
uniform int uRenderEngine;
uniform int uSchedulerMode;
uniform int uDebugLens;
uniform int uEnvPreset;
uniform int uMatCapLightBlend;
uniform int uSdfVoxelDefectDemo;
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

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 r2Sequence(int idx, vec2 shift) {
  return fract(shift + vec2(0.754877666, 0.569840291) * float(idx + 1));
}

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
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

vec2 mapVehicle(vec3 worldP, vec3 carPos, float carYaw, out vec3 localOut) {
  vec3 p = worldP - carPos;
  p.xz = rotateXZ(p.xz, -carYaw);
  localOut = p;

  float boundD = length(p - vec3(0.0, 0.72, 0.0)) - 3.1;
  if (boundD > 0.45) {
    return vec2(boundD, 10.0);
  }

  vec3 chP = p - vec3(0.0, 0.48, 0.0);
  float wedgeSlope = clamp((p.z + 2.0) / 4.2, 1e-4, 1.0);
  float bodyHeight = mix(0.32, 0.20, pow(wedgeSlope, 1.6));
  float chassis = sdRoundBox(chP, vec3(0.92, bodyHeight, 2.08), 0.14);

  vec3 mirP = vec3(abs(p.x), p.y, p.z);
  float frontFender = sdRoundBox(mirP - vec3(0.79, 0.51, 1.32), vec3(0.18, 0.18, 0.45), 0.11);
  float rearFender = sdRoundBox(mirP - vec3(0.83, 0.54, -1.28), vec3(0.20, 0.21, 0.48), 0.12);
  chassis = smin(chassis, min(frontFender, rearFender), 0.12);

  vec3 cabP = p - vec3(0.0, 0.88, -0.26);
  cabP.y += max(0.0, cabP.z - 0.1) * 0.25;
  cabP.y += max(0.0, -cabP.z - 0.15) * 0.14;
  float cabin = sdRoundBox(cabP, vec3(0.68, 0.26, 0.96), 0.17);

  vec3 wheelMir = vec3(abs(p.x) - 0.88, p.y - 0.34, abs(p.z) - 1.32);
  float wheelCut = sdCylinderX(wheelMir, 0.22, 0.41);
  float body = max(smin(chassis, cabin, 0.14), -wheelCut);

  float wingBlade = sdRoundBox(p - vec3(0.0, 0.99, -2.02), vec3(0.86, 0.025, 0.16), 0.012);
  float wingPosts = sdBox(vec3(abs(p.x) - 0.44, p.y - 0.85, p.z + 1.96), vec3(0.03, 0.14, 0.07));
  float bestD = min(body, min(wingBlade, wingPosts));
  float bestM = 10.0;

  if (p.y > 0.72 && abs(p.x) < 0.72 && p.z > -1.35 && p.z < 0.78) {
    float cabinShell = max(cabin, -(p.y - 0.74));
    if (cabinShell < bestD + 0.012) {
      bestD = cabinShell;
      bestM = 11.0;
    }
  }

  float tireD = sdCylinderX(wheelMir, 0.14, 0.34);
  if (tireD < bestD) { bestD = tireD; bestM = 12.0; }
  float rimD = sdCylinderX(wheelMir - vec3(0.02, 0.0, 0.0), 0.145, 0.23);
  if (rimD < bestD) { bestD = rimD; bestM = 13.0; }

  float headLampD = sdRoundBox(vec3(abs(p.x) - 0.68, p.y - 0.50, p.z - 2.09), vec3(0.18, 0.042, 0.06), 0.016);
  if (headLampD < bestD) { bestD = headLampD; bestM = 14.0; }

  float tailLampD = sdRoundBox(p - vec3(0.0, 0.61, -2.14), vec3(0.84, 0.034, 0.045), 0.015);
  if (tailLampD < bestD) { bestD = tailLampD; bestM = 15.0; }

  return vec2(bestD, bestM);
}

// O(1) analytic ring distance for up to 48 emissive pylons (3 rings x 16 slots)
vec2 mapAnalyticPylonRings(vec3 p) {
  if (uEmissivePylonCount <= 0 || p.y > 1.0) return vec2(10.0, -1.0);
  vec2 c = p.xz - vec2(0.0, 0.5);
  float r = length(c);
  if (r < 3.6 || r > 7.4) return vec2(min(abs(r - 4.25), 1.0) + 0.15, -1.0);

  float bestD = 10.0;
  float bestM = -1.0;
  float angRaw = (abs(c.x) + abs(c.y) < 1e-4) ? 0.0 : atan(c.y, c.x);

  for (int ring = 0; ring < 3; ++ring) {
    int ringStart = ring * 16;
    if (ringStart >= uEmissivePylonCount) break;
    float rad = 4.25 + float(ring) * 1.2;
    if (abs(r - rad) > 0.65) continue;

    float phase = float(ring) * 0.19635;
    float sector = mod(floor((angRaw - phase) / (TWO_PI / 16.0) + 0.5) + 16.0, 16.0);
    int idx = ringStart + int(sector);
    if (idx < uEmissivePylonCount) {
      float a = sector * (TWO_PI / 16.0) + phase;
      vec3 pp = vec3(cos(a) * rad, 0.30 + 0.10 * sin(float(idx) * 1.7), sin(a) * rad + 0.5);
      float pd = sdBox(p - pp, vec3(0.065, 0.28, 0.065));
      if (pd < bestD) {
        bestD = pd;
        bestM = 20.0 + float(idx);
      }
    }
  }
  return vec2(bestD, bestM);
}

vec2 mapScene(vec3 p, out vec3 localCarP) {
  vec2 res = mapVehicle(p, uCarPos, uCarYaw, localCarP);

  if (p.y < res.x) {
    res = vec2(p.y, 1.0);
  }

  if (uEnvPreset == 0) {
    float calWall = sdBox(p - vec3(0.0, 1.9, 7.6), vec3(6.8, 1.9, 0.2));
    float sideWall = sdBox(p - vec3(-6.8, 2.0, 1.0), vec3(0.25, 2.0, 6.8));
    float rearWall = sdBox(p - vec3(0.0, 2.0, -6.8), vec3(6.8, 2.0, 0.25));
    float envD = min(calWall, min(sideWall, rearWall));
    if (envD < res.x) res = vec2(envD, 2.0);
  } else if (uEnvPreset == 1) {
    float calWall = sdBox(p - vec3(0.0, 1.7, 7.8), vec3(7.2, 1.7, 0.25));
    if (calWall < res.x) res = vec2(calWall, 2.0);
    // 4 sculpted forest trunks outside central pad
    float t1 = sdCylinderY(p - vec3(5.6, 2.5, -2.8), 2.5, 0.28);
    float t2 = sdCylinderY(p - vec3(-5.8, 2.5, -2.2), 2.5, 0.25);
    float t3 = sdCylinderY(p - vec3(6.2, 2.5, 3.2), 2.5, 0.30);
    float t4 = sdCylinderY(p - vec3(-6.0, 2.5, 3.6), 2.5, 0.26);
    float td = min(min(t1, t2), min(t3, t4));
    if (td < res.x) res = vec2(td, 7.0);
  } else {
    float backWall = sdBox(p - vec3(0.0, 2.2, 7.8), vec3(8.5, 2.2, 0.22));
    float leftWallUpper = sdBox(p - vec3(-6.2, 3.35, 0.5), vec3(0.24, 0.95, 7.5));
    float leftPillarA = sdBox(p - vec3(-6.2, 1.35, -3.5), vec3(0.28, 1.35, 2.0));
    float leftPillarB = sdBox(p - vec3(-6.2, 1.35, 5.2), vec3(0.28, 1.35, 2.1));
    float ceilingBeam = sdBox(p - vec3(0.0, 4.35, 1.2), vec3(7.5, 0.25, 7.5));
    float archD = min(min(backWall, ceilingBeam), min(leftWallUpper, min(leftPillarA, leftPillarB)));
    if (archD < res.x) res = vec2(archD, 2.0);
  }

  float sChrome = length(p - vec3(-2.55, 0.46, 2.4)) - 0.46;
  if (sChrome < res.x) res = vec2(sChrome, 3.0);

  float sOrange = length(p - vec3(-2.55, 0.46, 1.0)) - 0.46;
  if (sOrange < res.x) res = vec2(sOrange, 4.0);

  float sMatte = length(p - vec3(-2.55, 0.46, -0.4)) - 0.46;
  if (sMatte < res.x) res = vec2(sMatte, 5.0);

  float softboxMesh = sdBox(p - vec3(0.2, 3.88, 0.2), vec3(1.85, 0.04, 0.85));
  if (softboxMesh < res.x) res = vec2(softboxMesh, 6.0);

  vec2 pylonRes = mapAnalyticPylonRings(p);
  if (pylonRes.x < res.x && pylonRes.y > 0.0) res = pylonRes;

  return res;
}

float mapDistanceOnly(vec3 p) {
  vec3 dummy;
  return mapScene(p, dummy).x;
}

vec3 calcNormal(vec3 p) {
  const vec2 e = vec2(0.0024, -0.0024);
  return normalize(
    e.xyy * mapDistanceOnly(p + e.xyy) +
    e.yyx * mapDistanceOnly(p + e.yyx) +
    e.yxy * mapDistanceOnly(p + e.yxy) +
    e.xxx * mapDistanceOnly(p + e.xxx)
  );
}

float traceExactShadow(vec3 ro, vec3 rd, float maxT, float bias) {
  float t = max(bias, 0.04);
  float minRes = 1.0;
  for (int i = 0; i < 24; ++i) {
    float h = mapDistanceOnly(ro + rd * t);
    if (h < 0.003) return 0.0;
    minRes = min(minRes, 18.0 * h / t);
    t += clamp(h, 0.05, 0.75);
    if (t >= maxT) break;
  }
  return clamp(minRes, 0.0, 1.0);
}

float traceGdfConeShadow(vec3 ro, vec3 rd, float maxT, float coneSoftness) {
  float t = 0.06;
  float res = 1.0;
  for (int i = 0; i < 12; ++i) {
    float h = mapDistanceOnly(ro + rd * t);
    if (h < 0.0025) return 0.0;
    res = min(res, coneSoftness * h / t);
    t += clamp(h * 1.2, 0.09, 0.85);
    if (t >= maxT) break;
  }
  return clamp(res * res * (3.0 - 2.0 * res), 0.0, 1.0);
}

float calcSdfAmbientOcclusion(vec3 pos, vec3 nor) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 4; ++i) {
    float h = 0.04 + 0.18 * float(i);
    float d = mapDistanceOnly(pos + h * nor);
    occ += (h - d) * sca;
    sca *= 0.70;
  }
  return clamp(1.0 - 1.55 * occ, 0.20, 1.0);
}

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
  float thetaF = (theta / PI) * 127.0;
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

float ggxNdf(float nDotH, float rough) {
  float a = max(rough * rough, 0.002);
  float a2 = a * a;
  float d = (nDotH * nDotH) * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-6);
}

float smithGeometry(float nDotV, float nDotL, float rough) {
  float r = rough + 1.0;
  float k = (r * r) * 0.125;
  return (nDotV / (nDotV * (1.0 - k) + k)) * (nDotL / (nDotL * (1.0 - k) + k));
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

vec3 evalUnifiedLuminaireNoShadow(
  int lumIdx, vec3 P, vec3 N, vec3 V,
  vec3 albedo, float metallic, float rough, float clearcoat,
  out vec3 outShadowDir, out float outShadowDist, out float outLuxNoVis
) {
  vec4 t0, t1, t2, t3;
  fetchLuminaire(lumIdx, t0, t1, t2, t3);
  int cat = int(floor(t2.w + 0.5));
  outShadowDir = vec3(0.0, 1.0, 0.0);
  outShadowDist = 0.0;
  outLuxNoVis = 0.0;

  if (cat == 2 || cat == 4) {
    // AreaQuad LTC
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
    if (!twoSided && dot(emitN, -toCenter) <= 0.0) return vec3(0.0);

    vec3 uVec = rightAxis * halfW;
    vec3 vVec = upAxis * halfH;
    vec3 v0 = normalize(center - uVec - vVec - P);
    vec3 v1 = normalize(center + uVec - vVec - P);
    vec3 v2 = normalize(center + uVec + vVec - P);
    vec3 v3 = normalize(center - uVec + vVec - P);

    vec3 c01 = cross(v0, v1); float l01 = length(c01);
    vec3 c12 = cross(v1, v2); float l12 = length(c12);
    vec3 c23 = cross(v2, v3); float l23 = length(c23);
    vec3 c30 = cross(v3, v0); float l30 = length(c30);
    vec3 vecIrr =
      (l01 > 1e-5 ? c01 / l01 : vec3(0.0)) * acos(clamp(dot(v0, v1), -0.9999, 0.9999)) +
      (l12 > 1e-5 ? c12 / l12 : vec3(0.0)) * acos(clamp(dot(v1, v2), -0.9999, 0.9999)) +
      (l23 > 1e-5 ? c23 / l23 : vec3(0.0)) * acos(clamp(dot(v2, v3), -0.9999, 0.9999)) +
      (l30 > 1e-5 ? c30 / l30 : vec3(0.0)) * acos(clamp(dot(v3, v0), -0.9999, 0.9999));

    float irradFactor = abs(dot(vecIrr, N)) * (0.5 / PI);
    float dist = length(toCenter);
    vec3 L = toCenter / max(dist, 1e-4);
    if (collimation > 0.1) irradFactor *= pow(max(dot(emitN, -L), 1e-4), collimation);

    vec3 R = reflect(-V, N);
    float rDotEn = dot(R, emitN);
    vec3 repPos = center;
    if (abs(rDotEn) > 1e-4) {
      float tPlane = dot(center - P, emitN) / rDotEn;
      if (tPlane > 0.0) {
        vec3 delta = (P + R * tPlane) - center;
        repPos = center + rightAxis * clamp(dot(delta, rightAxis), -halfW, halfW)
                        + upAxis * clamp(dot(delta, upAxis), -halfH, halfH);
      }
    }
    vec3 Lspec = normalize(repPos - P);
    float area = 4.0 * halfW * halfH;
    float areaSolid = area / max(dist * dist + area, 0.08);
    outShadowDir = L;
    outShadowDist = dist;
    outLuxNoVis = irradFactor * max(col.r, max(col.g, col.b));

    float specRough = clamp(rough + sqrt(areaSolid) * 0.18, 0.04, 1.0);
    vec3 specOnly = evalOpenPbrBrdf(N, V, Lspec, albedo, metallic, specRough, clearcoat, 0.045, areaSolid * 2.4, Lspec);
    vec3 pureDiff = albedo * (1.0 - metallic) / PI * max(dot(N, Lspec), 0.0);
    vec3 pureSpec = max(specOnly - pureDiff, vec3(0.0));
    if (uDebugLens == 5) return pureSpec * col;
    return ((albedo * (1.0 - metallic)) * irradFactor + pureSpec) * col;
  }

  vec3 L_eval = vec3(0.0);
  vec3 L_spec = vec3(0.0);
  float effRough = rough;
  float totalScale = 0.0;

  if (cat == 3) {
    vec3 segA = t0.xyz;
    float radius = max(t0.w, 0.015);
    vec3 segB = t1.xyz;
    float rangeM = max(t1.w, 1.0);
    vec3 ab = segB - segA;
    float abLen2 = max(dot(ab, ab), 1e-6);
    vec3 closestPt = segA + ab * clamp(dot(P - segA, ab) / abLen2, 0.0, 1.0);
    vec3 toL = closestPt - P;
    float dist = length(toL);
    L_eval = toL / max(dist, 1e-4);

    vec3 R = reflect(-V, N);
    vec3 L0 = segA - P;
    vec3 Ld = (segB - P) - L0;
    float rDotLd = dot(R, Ld);
    float tSpec = clamp((dot(R, L0) * rDotLd - dot(L0, Ld)) / max(dot(Ld, Ld) - rDotLd * rDotLd, 1e-5), 0.0, 1.0);
    L_spec = normalize(mix(segA, segB, tSpec) - P);

    float atten = smoothRangeWindow(dist, rangeM) / max(dist * dist + radius * radius, 0.04);
    float capsuleNorm = min(1.8, 0.45 + sqrt(abLen2) * 0.55);
    totalScale = atten * capsuleNorm;
    outShadowDir = L_eval;
    outShadowDist = dist;
  } else {
    vec3 lPos = t0.xyz;
    float rangeM = max(t0.w, 1.0);
    vec3 beamAxis = normalize(t1.xyz);
    float radius = max(t1.w, 0.02);
    vec3 zeroAz = t2.xyz;
    int profileOrd = int(floor(t3.w + 0.5));

    vec3 toL = lPos - P;
    float dist = length(toL);
    L_eval = toL / max(dist, 1e-4);
    L_spec = L_eval;
    float iesW = (cat == 1) ? sampleIesAtlas128x32(profileOrd, -L_eval, beamAxis, zeroAz) : 1.0;
    totalScale = iesW * smoothRangeWindow(dist, rangeM) / max(dist * dist + radius * radius * 0.5, 0.04);
    effRough = clamp(rough + radius / max(2.0 * dist, 0.1), 0.04, 1.0);
    outShadowDir = L_eval;
    outShadowDist = dist;
  }

  vec3 col = t3.rgb;
  outLuxNoVis = max(dot(N, L_eval), 0.0) * totalScale * max(col.r, max(col.g, col.b));
  vec3 brdf = evalOpenPbrBrdf(N, V, L_eval, albedo, metallic, effRough, clearcoat, 0.045, 1.0, L_spec);
  if (uDebugLens == 5) {
    vec3 pureDiff = albedo * (1.0 - metallic) / PI * max(dot(N, L_eval), 0.0);
    return max(brdf - pureDiff, vec3(0.0)) * col * totalScale;
  }
  return brdf * col * totalScale;
}

float partitionCellImportance(vec3 P, vec3 N, vec4 n0, vec4 n1, vec4 n2, vec4 n3) {
  float power = n0.w;
  if (power <= 1e-5) return 0.0;
  vec3 center = 0.5 * (n0.xyz + n1.xyz);
  float radius = length(0.5 * (n1.xyz - n0.xyz));
  vec3 delta = P - center;
  float dist2 = max(dot(delta, delta), max(radius * radius * 0.25, 0.08));
  float dist = sqrt(dist2);
  vec3 dirFromCluster = delta / dist;

  float thetaU = asin(clamp(radius / max(dist, radius + 1e-4), 0.0, 0.99999));
  float thetaO = acos(clamp(n2.w, -0.99999, 0.99999));
  float theta = acos(clamp(dot(n2.xyz, dirFromCluster), -0.99999, 0.99999));
  float effTheta = max(0.0, theta - thetaO - thetaU);
  float coneWeight = (effTheta >= n3.z) ? 0.03 : max(0.08, cos(effTheta));
  float cosNormal = clamp(dot(N, -dirFromCluster) + thetaU, 0.05, 1.0);
  return (power * coneWeight * cosNormal) / dist2;
}

vec3 evalEnvironmentSky(vec3 dir) {
  float y = dir.y;
  float sunDot = max(dot(dir, uSunDir), 1e-4);
  if (uEnvPreset == 0) {
    float t = clamp(y * 1.4, 0.0, 1.0);
    float coveRing = exp(-pow((y - 0.28) / 0.12, 2.0)) * 0.26;
    return mix(vec3(0.025, 0.028, 0.036), vec3(0.05, 0.068, 0.095), t) + vec3(0.9, 0.94, 1.05) * coveRing;
  } else if (uEnvPreset == 1) {
    float up = max(y, 1e-4);
    vec3 sky = mix(vec3(0.32, 0.44, 0.52), vec3(0.11, 0.28, 0.68), pow(up, 0.65));
    float sunGlow = pow(sunDot, 22.0) * 1.4 + pow(sunDot, 420.0) * 14.0;
    return (y < 0.0 ? vec3(0.05, 0.08, 0.045) : sky) + uSunColor * sunGlow;
  } else {
    float up = max(y, 1e-4);
    vec3 sky = mix(vec3(0.55, 0.44, 0.36), vec3(0.15, 0.30, 0.62), pow(up, 0.6));
    float sunGlow = pow(sunDot, 16.0) * 1.6 + pow(sunDot, 360.0) * 16.0;
    return (y < 0.0 ? vec3(0.08, 0.075, 0.07) : sky) + uSunColor * sunGlow;
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

void evalMaterial(
  float matId, vec3 worldP, vec3 localCarP, vec3 N,
  out vec3 albedo, out float metallic, out float rough, out float clearcoat, out vec3 emissive
) {
  albedo = vec3(0.5); metallic = 0.0; rough = 0.45; clearcoat = 0.0; emissive = vec3(0.0);
  if (matId < 1.5) {
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
    albedo = vec3(0.56, 0.57, 0.59);
    if (worldP.z > 7.1 && abs(worldP.x) < 5.0) {
      float tickY = smoothstep(0.012, 0.025, abs(fract(worldP.y * 2.0) - 0.5));
      float centerLine = smoothstep(0.015, 0.03, abs(worldP.x));
      albedo *= mix(0.65, 1.0, min(tickY, centerLine));
      albedo = mix(vec3(0.70, 0.71, 0.73), albedo, 0.4);
    }
    rough = 0.78;
  } else if (matId < 3.5) {
    albedo = vec3(0.92, 0.94, 0.96); metallic = 1.0; rough = 0.04;
  } else if (matId < 4.5) {
    albedo = vec3(0.84, 0.19, 0.05); metallic = 0.18; rough = 0.24; clearcoat = 1.0;
  } else if (matId < 5.5) {
    albedo = vec3(0.76, 0.76, 0.78); rough = 0.90;
  } else if (matId < 6.5) {
    albedo = vec3(0.18); rough = 0.5;
    if (N.y < -0.5) emissive = vec3(11.0, 11.4, 12.2);
  } else if (matId < 7.5) {
    albedo = vec3(0.15, 0.10, 0.07); rough = 0.86;
  } else if (matId < 10.5) {
    albedo = vec3(0.045, 0.145, 0.34); metallic = 0.72; rough = 0.22; clearcoat = 1.0;
  } else if (matId < 11.5) {
    albedo = vec3(0.03, 0.04, 0.055); metallic = 0.1; rough = 0.035; clearcoat = 1.0;
  } else if (matId < 12.5) {
    albedo = vec3(0.045, 0.046, 0.05); rough = 0.76;
  } else if (matId < 13.5) {
    albedo = vec3(0.76, 0.78, 0.82); metallic = 0.94; rough = 0.16;
  } else if (matId < 14.5) {
    albedo = vec3(0.85); rough = 0.08;
    float turnFlash = (abs(localCarP.x) > 0.76 && uTurnSignalActive > 0.5 && fract(uTimeSec * 2.2) < 0.55) ? 1.0 : 0.0;
    emissive = mix(vec3(16.0, 17.5, 20.0) * max(uDrlActive, uHeadlampIntensity), vec3(14.0, 6.2, 0.4) * turnFlash, turnFlash);
  } else if (matId < 15.5) {
    albedo = vec3(0.24, 0.01, 0.01); rough = 0.12;
    emissive = vec3(9.5, 0.32, 0.18) * (1.0 + uBrakeActive * 3.8);
  } else {
    float hue = fract(floor(matId - 20.0 + 0.5) * 0.27);
    vec3 neon = clamp(abs(fract(hue + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    albedo = neon * 0.4;
    emissive = (neon * 0.85 + vec3(0.15)) * 7.5;
  }
}

vec3 infernoPalette(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.33) return mix(vec3(0.04, 0.05, 0.16), vec3(0.32, 0.09, 0.48), t / 0.33);
  if (t < 0.66) return mix(vec3(0.32, 0.09, 0.48), vec3(0.85, 0.25, 0.22), (t - 0.33) / 0.33);
  return mix(vec3(0.85, 0.25, 0.22), vec3(0.98, 0.88, 0.25), (t - 0.66) / 0.34);
}
`;

// Program 1: Real-Time Engines 0, 1, 2, 3 — single luminaire evaluation loop!
const REALTIME_FRAGMENT_SRC =
  SHARED_GLSL_COMMON +
  `
vec3 shadePointRealTime(
  vec3 P, vec3 N, vec3 V,
  vec3 albedo, float metallic, float rough, float clearcoat,
  bool doShadows, bool fastSdfShadow, vec2 fragCoord,
  out int outCutEvals, out float outLuxTotal
) {
  outCutEvals = 0;
  outLuxTotal = 0.0;
  vec3 evalP = (uRenderEngine == 1 && uSdfVoxelDefectDemo == 1) ? (floor(P / 0.45) + 0.5) * 0.45 : P;
  vec3 total = vec3(0.0);

  if (uEnvPreset >= 1) {
    float sunVis = 1.0;
    if (doShadows && dot(N, uSunDir) > 0.0) {
      sunVis = fastSdfShadow ? traceGdfConeShadow(P + N * 0.02, uSunDir, 18.0, 12.0)
                             : traceExactShadow(P + N * 0.02, uSunDir, 20.0, 0.04);
    }
    total += evalOpenPbrBrdf(N, V, uSunDir, albedo, metallic, rough, clearcoat, 0.045, 1.0, uSunDir) * uSunColor * sunVis;
    outLuxTotal += max(dot(N, uSunDir), 0.0) * dot(uSunColor, vec3(0.3, 0.6, 0.1)) * sunVis;
  }

  if (uLuminaireCount <= 0) return total;

  // Phase 1: Candidate selection into compact 12-entry array (initialized for ANGLE/FXC!)
  const int MAX_CAND = 12;
  int candIds[12] = int[12](0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  int candCount = 0;
  float candMult = 1.0;
  vec3 tailApprox = vec3(0.0);

  if (uSchedulerMode == 2) {
    // Direct reference evaluates 0..min(uLuminaireCount, 32) via the single loop below
  } else if (uRenderEngine == 0) {
    int cap = min(uLuminaireCount, 4);
    for (int i = 0; i < 4; ++i) {
      if (i >= cap) break;
      candIds[i] = i;
      candCount++;
    }
  } else if (uSchedulerMode == 3) {
    for (int i = 0; i < 32; ++i) {
      if (i >= uLuminaireCount || candCount >= 8) break;
      vec4 t0, t1, t2, t3;
      fetchLuminaire(i, t0, t1, t2, t3);
      float lViewZ = dot(t0.xyz - uCamPos, uCamForward);
      vec3 toL = normalize(t0.xyz - uCamPos);
      if (lViewZ <= 0.2 || abs(dot(toL, uCamRight)) >= 0.78) continue;
      candIds[candCount++] = i;
    }
  } else if (uSchedulerMode == 4) {
    float r = hash12(fragCoord + vec2(uTimeSec * 60.0, 17.3));
    candIds[0] = clamp(int(floor(r * float(uLuminaireCount))), 0, uLuminaireCount - 1);
    candCount = 1;
    candMult = float(uLuminaireCount) * 0.52;
    vec3 ghostDelta = P - uPrevCarPos;
    total += vec3(1.6, 0.14, 0.08) * exp(-dot(ghostDelta, ghostDelta) * 0.55) * length(uCarPos - uPrevCarPos) * 14.0;
  } else {
    int targetBudget = (uSchedulerMode == 1 || uRenderEngine == 1) ? 6 : 10;
    const int QMAX = 10;
    int qCells[10] = int[10](0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    float qScores[10] = float[10](0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    int qSize = 0;

    if (uPartitionCellCount > 0) {
      vec4 rn0, rn1, rn2, rn3;
      fetchPartitionCell(0, rn0, rn1, rn2, rn3);
      qCells[0] = 0;
      qScores[0] = partitionCellImportance(evalP, N, rn0, rn1, rn2, rn3);
      qSize = 1;
    }

    for (int iter = 0; iter < 18; ++iter) {
      if (qSize <= 0 || candCount >= targetBudget) break;
      int bestSlot = 0;
      float bestScore = qScores[0];
      for (int k = 1; k < QMAX; ++k) {
        if (k >= qSize) break;
        if (qScores[k] > bestScore) { bestScore = qScores[k]; bestSlot = k; }
      }
      int cellIdx = qCells[bestSlot];
      qSize--;
      qCells[bestSlot] = qCells[qSize];
      qScores[bestSlot] = qScores[qSize];

      vec4 n0, n1, n2, n3;
      fetchPartitionCell(cellIdx, n0, n1, n2, n3);
      int link = int(floor(n1.w + 0.5));
      if (link < 0) {
        int lumIdx = -link - 1;
        if (lumIdx >= 0 && lumIdx < uLuminaireCount) candIds[candCount++] = lumIdx;
      } else if (link >= 0 && link + 1 < uPartitionCellCount && qSize + 2 <= QMAX) {
        vec4 ln0, ln1, ln2, ln3, rn0, rn1, rn2, rn3;
        fetchPartitionCell(link, ln0, ln1, ln2, ln3);
        qCells[qSize] = link;
        qScores[qSize] = partitionCellImportance(evalP, N, ln0, ln1, ln2, ln3);
        qSize++;
        fetchPartitionCell(link + 1, rn0, rn1, rn2, rn3);
        qCells[qSize] = link + 1;
        qScores[qSize] = partitionCellImportance(evalP, N, rn0, rn1, rn2, rn3);
        qSize++;
      }
    }

    for (int r = 0; r < QMAX; ++r) {
      if (r >= qSize) break;
      vec4 n0, n1, n2, n3;
      fetchPartitionCell(qCells[r], n0, n1, n2, n3);
      vec3 toC = 0.5 * (n0.xyz + n1.xyz) - evalP;
      float d2 = max(dot(toC, toC), 1.5);
      float diffFactor = max(dot(N, normalize(toC)), 0.0) * n0.w / (4.0 * PI * d2);
      tailApprox += (albedo * (1.0 - metallic)) * diffFactor * 0.22;
    }
  }

  // Phase 2: Analytical luminaire sum (zero shadow rays and zero dynamic shadow arrays!)
  vec3 shDir0 = vec3(0.0, 1.0, 0.0); float shDist0 = 0.0; vec3 shRad0 = vec3(0.0);
  vec3 shDir1 = vec3(0.0, 1.0, 0.0); float shDist1 = 0.0; vec3 shRad1 = vec3(0.0);
  vec3 shDir2 = vec3(0.0, 1.0, 0.0); float shDist2 = 0.0; vec3 shRad2 = vec3(0.0);
  int shCaptured = 0;

  int loopCount = (uSchedulerMode == 2) ? min(uLuminaireCount, 32) : candCount;
  for (int e = 0; e < 32; ++e) {
    if (e >= loopCount) break;
    int lumIdx = (uSchedulerMode == 2) ? e : candIds[e < MAX_CAND ? e : 0];
    vec3 shDir;
    float shDist, luxVal;
    vec3 rad = evalUnifiedLuminaireNoShadow(lumIdx, evalP, N, V, albedo, metallic, rough, clearcoat, shDir, shDist, luxVal);
    outLuxTotal += luxVal * candMult;

    if (doShadows && shCaptured < 3 && shDist > 0.12 && max(rad.r, max(rad.g, rad.b)) > 0.008) {
      if (shCaptured == 0) { shDir0 = shDir; shDist0 = shDist; shRad0 = rad * candMult; }
      else if (shCaptured == 1) { shDir1 = shDir; shDist1 = shDist; shRad1 = rad * candMult; }
      else { shDir2 = shDir; shDist2 = shDist; shRad2 = rad * candMult; }
      shCaptured++;
    } else {
      total += rad * candMult;
    }
  }

  // Phase 3: Explicit scalar shadow evaluation (zero dynamic indexing in shadow loop!)
  if (shCaptured > 0) {
    float v0 = fastSdfShadow
      ? traceGdfConeShadow(P + N * 0.02, shDir0, min(shDist0 - 0.14, 14.0), 9.0)
      : traceExactShadow(P + N * 0.02, shDir0, min(shDist0 - 0.14, 15.0), 0.04);
    total += shRad0 * v0;
  }
  if (shCaptured > 1) {
    float v1 = fastSdfShadow
      ? traceGdfConeShadow(P + N * 0.02, shDir1, min(shDist1 - 0.14, 14.0), 9.0)
      : traceExactShadow(P + N * 0.02, shDir1, min(shDist1 - 0.14, 15.0), 0.04);
    total += shRad1 * v1;
  }
  if (shCaptured > 2) {
    float v2 = fastSdfShadow
      ? traceGdfConeShadow(P + N * 0.02, shDir2, min(shDist2 - 0.14, 14.0), 9.0)
      : traceExactShadow(P + N * 0.02, shDir2, min(shDist2 - 0.14, 15.0), 0.04);
    total += shRad2 * v2;
  }

  outCutEvals = loopCount;
  return total + tailApprox;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec3 rd = normalize(uCamForward + uCamRight * (ndc.x * aspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));
  vec3 ro = uCamPos;

  float t = 0.05;
  float hitMat = -1.0;
  vec3 hitLocalCar = vec3(0.0);
  for (int i = 0; i < 96; ++i) {
    vec2 d = mapScene(ro + rd * t, hitLocalCar);
    if (d.x < 0.002) { hitMat = d.y; break; }
    t += clamp(d.x, 0.012, 1.4);
    if (t > 42.0) break;
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

    bool isMatCap = (uRenderEngine == 0);
    bool fastSdf = (uRenderEngine == 1);
    bool doSh = !isMatCap;

    int cutEvals;
    float luxTotal;
    vec3 direct = (isMatCap && uMatCapLightBlend == 0)
      ? vec3(0.0)
      : shadePointRealTime(P, N, V, albedo, metallic, rough, clearcoat, doSh, fastSdf, gl_FragCoord.xy, cutEvals, luxTotal);

    if (isMatCap) {
      vec2 nv = vec2(dot(N, uCamRight), dot(N, uCamUp));
      float nz = sqrt(max(0.0, 1.0 - min(dot(nv, nv), 1.0)));
      float keyCurve = clamp(dot(normalize(vec3(nv, nz)), normalize(vec3(-0.35, 0.72, 0.6))), 1e-4, 1.0);
      vec3 baseClay = (hitMat > 9.5 && hitMat < 10.5) ? vec3(0.22, 0.34, 0.56) : albedo * 0.68 + vec3(0.14);
      vec3 matcap = baseClay * (0.32 + 0.68 * pow(keyCurve, 1.35))
        + vec3(0.28, 0.32, 0.38) * pow(max(1.0 - nz, 1e-4), 2.6)
        + vec3(pow(keyCurve, 26.0) * 0.45);
      finalRgb = (uMatCapLightBlend == 1)
        ? matcap * 0.68 + evalEnvironmentHarmonics(N) * 0.35 + direct * 0.55 + emissive * 0.5
        : matcap + emissive * 0.5;
    } else {
      float ao = (uRenderEngine == 1 || uRenderEngine == 3) ? calcSdfAmbientOcclusion(P, N) : 1.0;
      float effClearcoat = (uSdfVoxelDefectDemo == 1 && uRenderEngine == 1) ? 0.0 : clearcoat;
      float effRough = (uSdfVoxelDefectDemo == 1 && uRenderEngine == 1) ? max(rough, 0.65) : rough;

      vec3 diffuseIbl = evalEnvironmentHarmonics(N) * (albedo * (1.0 - metallic)) * ao;
      vec3 R = reflect(-V, N);
      vec3 envSpec = mix(evalEnvironmentSky(R), evalEnvironmentHarmonics(R), clamp(effRough * 1.15, 0.0, 1.0));
      float nDotV = max(dot(N, V), 1e-4);
      vec3 specIbl = envSpec * fresnelSchlick(nDotV, mix(vec3(0.04), albedo, metallic)) * ao;
      if (effClearcoat > 0.01) {
        float Fc = fresnelSchlick(nDotV, vec3(0.04)).r * effClearcoat;
        specIbl = specIbl * (1.0 - Fc * 0.65) + evalEnvironmentSky(R) * Fc;
      }

      vec3 radBleed = vec3(0.0);
      if (uRenderEngine == 1 || uRenderEngine == 3) {
        float giStr = (uRenderEngine == 3) ? 1.0 : 0.62;
        float floorFacing = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
        float underMask = clamp(length(P.xz - uCarPos.xz) * 0.45, 0.35, 1.0);
        vec3 warmBounce = vec3(0.11, 0.12, 0.13) * exp(-dot(P.xz, P.xz) * 0.08) * floorFacing * underMask;
        if (uEnvPreset >= 1) warmBounce += uSunColor * 0.085 * floorFacing * underMask;
        vec3 carF = vec3(sin(uCarYaw), 0.0, cos(uCarYaw));
        vec3 tailPos = uCarPos - carF * 2.2;
        vec3 nosePos = uCarPos + carF * 2.2;
        vec3 rubyB = vec3(0.85, 0.04, 0.02) * (1.0 + uBrakeActive * 2.2) / (dot(P - tailPos, P - tailPos) + 0.45) * 0.52;
        vec3 drlB = vec3(0.35, 0.42, 0.55) * max(uDrlActive, uHeadlampIntensity) / (dot(P - nosePos, P - nosePos) + 0.45) * 0.45;
        radBleed = (warmBounce + rubyB + drlB) * (albedo * (1.0 - metallic)) * giStr * ao;
      }

      vec3 giOnly = diffuseIbl + radBleed;
      vec3 envGi = (uDebugLens == 5) ? specIbl : (giOnly + specIbl);

      if (uDebugLens == 1) finalRgb = infernoPalette(float(cutEvals) / 10.0);
      else if (uDebugLens == 2) finalRgb = infernoPalette(log2(1.0 + luxTotal * 1.4) / 5.5);
      else if (uDebugLens == 3) finalRgb = vec3(traceGdfConeShadow(P + N * 0.02, normalize(vec3(0.45, 0.85, 0.3)), 14.0, fastSdf ? 8.0 : 26.0) * ao);
      else if (uDebugLens == 4) finalRgb = giOnly * 2.2;
      else if (uDebugLens == 5) finalRgb = direct + envGi + emissive * 0.1;
      else finalRgb = direct + envGi + emissive;
    }
  }

  fragColor = vec4(max(finalRgb, vec3(0.0)), 1.0);
}
`;

// Program 2: Dedicated lean Progressive Deterministic (0,2) Path Tracer (Engine 4)
const PATHTRACER_FRAGMENT_SRC =
  SHARED_GLSL_COMMON +
  `
vec3 traceStochasticNee(vec3 P, vec3 N, vec3 V, vec3 albedo, float metallic, float rough, float clearcoat, vec2 xi, out int outEvals) {
  outEvals = 0;
  vec3 total = vec3(0.0);

  if (uEnvPreset >= 1 && dot(N, uSunDir) > 0.0) {
    float vis = traceExactShadow(P + N * 0.02, uSunDir, 18.0, 0.04);
    total += evalOpenPbrBrdf(N, V, uSunDir, albedo, metallic, rough, clearcoat, 0.045, 1.0, uSunDir) * uSunColor * vis;
  }

  if (uLuminaireCount <= 0) return total;

  // Stochastic descent through binary Photometric Partition (1/Pdf importance draw x 3 cuts)
  for (int c = 0; c < 3; ++c) {
    int cellIdx = 0;
    float pdf = 1.0;
    float u = fract(xi.x + float(c) * 0.33333);
    int pickedLum = -1;

    for (int lvl = 0; lvl < 10; ++lvl) {
      vec4 n0, n1, n2, n3;
      fetchPartitionCell(cellIdx, n0, n1, n2, n3);
      int link = int(floor(n1.w + 0.5));
      if (link < 0) {
        pickedLum = -link - 1;
        break;
      }
      if (link + 1 >= uPartitionCellCount) break;
      vec4 ln0, ln1, ln2, ln3, rn0, rn1, rn2, rn3;
      fetchPartitionCell(link, ln0, ln1, ln2, ln3);
      fetchPartitionCell(link + 1, rn0, rn1, rn2, rn3);
      float wL = max(partitionCellImportance(P, N, ln0, ln1, ln2, ln3), 1e-6);
      float wR = max(partitionCellImportance(P, N, rn0, rn1, rn2, rn3), 1e-6);
      float pL = wL / (wL + wR);
      if (u < pL) {
        cellIdx = link;
        pdf *= pL;
        u = u / max(pL, 1e-4);
      } else {
        cellIdx = link + 1;
        pdf *= (1.0 - pL);
        u = (u - pL) / max(1.0 - pL, 1e-4);
      }
    }

    if (pickedLum >= 0 && pickedLum < uLuminaireCount && pdf > 1e-4) {
      vec3 shDir;
      float shDist, luxVal;
      vec3 rad = evalUnifiedLuminaireNoShadow(pickedLum, P, N, V, albedo, metallic, rough, clearcoat, shDir, shDist, luxVal);
      float vis = (shDist > 0.08 && max(rad.r, max(rad.g, rad.b)) > 0.002)
        ? traceExactShadow(P + N * 0.02, shDir, min(shDist - 0.14, 15.0), 0.04)
        : 1.0;
      total += (rad * vis) / (pdf * 3.0);
      outEvals++;
    }
  }
  return total;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 shift = vec2(hash12(gl_FragCoord.xy), hash12(gl_FragCoord.xy + 19.7));
  vec2 jitter = (r2Sequence(uAccumFrame, shift) - 0.5) / uResolution * 1.4;
  vec3 rd = normalize(uCamForward + uCamRight * ((ndc.x + jitter.x * 2.0) * aspect * uTanHalfFov) + uCamUp * ((ndc.y + jitter.y * 2.0) * uTanHalfFov));
  vec3 ro = uCamPos;

  float t = 0.05;
  float hitMat = -1.0;
  vec3 hitLocalCar = vec3(0.0);
  for (int i = 0; i < 96; ++i) {
    vec2 d = mapScene(ro + rd * t, hitLocalCar);
    if (d.x < 0.002) { hitMat = d.y; break; }
    t += clamp(d.x, 0.012, 1.4);
    if (t > 42.0) break;
  }

  vec3 finalRgb = vec3(0.0);
  if (hitMat < 0.0) {
    finalRgb = evalEnvironmentSky(rd);
  } else {
    vec3 P = ro + rd * t;
    vec3 N = calcNormal(P);
    vec3 V = -rd;
    vec3 albedo, emissive;
    float metallic, rough, clearcoat;
    evalMaterial(hitMat, P, hitLocalCar, N, albedo, metallic, rough, clearcoat, emissive);

    vec2 xi = r2Sequence(uAccumFrame * 3 + 7, shift);
    int evals;
    vec3 rad = traceStochasticNee(P, N, V, albedo, metallic, rough, clearcoat, xi, evals) + emissive;

    vec3 ortho1 = normalize(abs(N.y) < 0.99 ? cross(N, vec3(0.0, 1.0, 0.0)) : cross(N, vec3(1.0, 0.0, 0.0)));
    vec3 ortho2 = cross(N, ortho1);
    float specProb = clamp(mix(0.25, 0.92, max(metallic, clearcoat)), 0.15, 0.92);
    vec2 bXi = r2Sequence(uAccumFrame * 5 + 11, shift);
    vec3 bounceDir, bounceW;
    if (bXi.x < specProb) {
      vec3 R = reflect(-V, N);
      float effR = clearcoat > 0.5 && bXi.y < 0.5 ? 0.045 : rough;
      float phi = bXi.y * TWO_PI;
      bounceDir = normalize(R + (ortho1 * cos(phi) + ortho2 * sin(phi)) * (effR * effR * sqrt(bXi.x / specProb)));
      bounceW = fresnelSchlick(max(dot(N, V), 1e-4), mix(vec3(0.04), albedo, max(metallic, clearcoat * 0.25))) / specProb;
    } else {
      float phi = bXi.y * TWO_PI;
      float u = (bXi.x - specProb) / max(1.0 - specProb, 1e-4);
      bounceDir = normalize(ortho1 * cos(phi) * sqrt(u) + ortho2 * sin(phi) * sqrt(u) + N * sqrt(1.0 - u));
      bounceW = (albedo * (1.0 - metallic)) / (1.0 - specProb);
    }

    float t2 = 0.04;
    float m2 = -1.0;
    vec3 lc2 = vec3(0.0);
    vec3 ro2 = P + N * 0.02;
    for (int s = 0; s < 42; ++s) {
      vec2 d2 = mapScene(ro2 + bounceDir * t2, lc2);
      if (d2.x < 0.005) { m2 = d2.y; break; }
      t2 += clamp(d2.x, 0.025, 1.2);
      if (t2 > 20.0) break;
    }
    if (m2 < 0.0) {
      rad += bounceW * evalEnvironmentSky(bounceDir);
    } else {
      vec3 P2 = ro2 + bounceDir * t2;
      vec3 N2 = calcNormal(P2);
      vec3 a2, e2;
      float mt2, r2m, cc2;
      evalMaterial(m2, P2, lc2, N2, a2, mt2, r2m, cc2, e2);
      rad += bounceW * (e2 + evalEnvironmentHarmonics(N2) * (a2 * (1.0 - mt2)));
      if (uEnvPreset >= 1 && dot(N2, uSunDir) > 0.0) {
        float v2 = traceGdfConeShadow(P2 + N2 * 0.02, uSunDir, 12.0, 10.0);
        rad += bounceW * evalOpenPbrBrdf(N2, -bounceDir, uSunDir, a2, mt2, r2m, cc2, 0.045, 1.0, uSunDir) * uSunColor * v2;
      }
    }
    finalRgb = rad;
    if (uDebugLens == 1) finalRgb = infernoPalette(float(evals) / 4.0);
  }

  vec3 clampedRgb = clamp(finalRgb, vec3(0.0), vec3(32.0));
  if (uAccumFrame > 0) {
    vec4 prev = texelFetch(uPrevAccumTex, ivec2(gl_FragCoord.xy), 0);
    fragColor = prev + vec4(clampedRgb, 1.0);
  } else {
    fragColor = vec4(clampedRgb, 1.0);
  }
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed (WebGL context lost)");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) || "(empty shader log)";
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
    const log = gl.getProgramInfoLog(prog) || (gl.isContextLost() ? "WebGL context lost during link" : "(empty link log)");
    throw new Error(`Program link failed: ${log}`);
  }
  return prog;
}

const MAIN_UNIFORM_NAMES = [
  "uResolution", "uCamPos", "uCamRight", "uCamUp", "uCamForward", "uTanHalfFov",
  "uLightRegisterTex", "uIesAtlasTex", "uPrevAccumTex",
  "uLuminaireCount", "uPartitionCellCount", "uRenderEngine", "uSchedulerMode",
  "uDebugLens", "uEnvPreset", "uMatCapLightBlend", "uSdfVoxelDefectDemo",
  "uAccumFrame", "uTimeSec", "uExposure",
  "uCarPos", "uCarYaw", "uPrevCarPos", "uPrevCarYaw",
  "uHeadlampIntensity", "uHighBeamActive", "uDrlActive", "uBrakeActive",
  "uTurnSignalActive", "uEmissivePylonCount",
  "uSunDir", "uSunColor", "uEnvSh[0]",
];

export class LightingGpuViewport {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      throw new Error("WebGL2 is required for LightingArchitectureLab.");
    }
    this.gl = gl;
    this.contextLost = false;
    this.floatFboExt = gl.getExtension("EXT_color_buffer_float");
    this.halfFloatFboExt = gl.getExtension("EXT_color_buffer_half_float");

    this.rtProg = linkProgram(gl, VERTEX_SHADER_SRC, REALTIME_FRAGMENT_SRC);
    this.ptProg = null; // Compiled on first click of PathTracer tab so initial boot is instant!
    this.blitProg = linkProgram(gl, VERTEX_SHADER_SRC, BLIT_FRAGMENT_SRC);
    this.emptyVao = gl.createVertexArray();

    this.lightRegisterTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lightRegisterTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 16, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.iesAtlasTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.iesAtlasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, IES_THETA_SAMPLES, IES_PHI_SAMPLES * IES_PROFILE_COUNT, 0, gl.RED, gl.FLOAT, null);
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

    this.rtUniforms = this._collectUniforms(this.rtProg, MAIN_UNIFORM_NAMES);
    this.ptUniforms = null;
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
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, IES_THETA_SAMPLES, IES_PHI_SAMPLES * IES_PROFILE_COUNT, gl.RED, gl.FLOAT, floatArray);
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
    if (this.contextLost || gl.isContextLost()) return;

    const renderScale = params.renderScale || 1.0;
    const w = Math.max(240, Math.floor(this.canvas.clientWidth * renderScale));
    const h = Math.max(160, Math.floor(this.canvas.clientHeight * renderScale));

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    const isPt = params.renderEngine === 4;
    if (isPt && !this.ptProg) {
      this.ptProg = linkProgram(gl, VERTEX_SHADER_SRC, PATHTRACER_FRAGMENT_SRC);
      this.ptUniforms = this._collectUniforms(this.ptProg, MAIN_UNIFORM_NAMES);
    }

    this._ensureAccumTargets(w, h);
    const readIdx = this.accumIndex;
    const writeIdx = 1 - this.accumIndex;

    const prog = isPt ? this.ptProg : this.rtProg;
    const u = isPt ? this.ptUniforms : this.rtUniforms;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbos[writeIdx]);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    gl.bindVertexArray(this.emptyVao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lightRegisterTex);
    gl.uniform1i(u.uLightRegisterTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.iesAtlasTex);
    gl.uniform1i(u.uIesAtlasTex, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTextures[readIdx]);
    gl.uniform1i(u.uPrevAccumTex, 2);

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

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTextures[writeIdx]);
    gl.uniform1i(this.blitUniforms.uAccumTex, 0);
    gl.uniform1f(this.blitUniforms.uExposure, params.exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.accumIndex = writeIdx;
    this.accumFrame = isPt ? Math.min(this.accumFrame + 1, 256) : 0;
  }
}
