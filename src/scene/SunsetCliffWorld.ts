import * as THREE from "three";
import type { MusicLyricFrame } from "../visualizer/MusicLyricReactivity";

export interface PaperTransform {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  width: number;
  height: number;
}

const SKY_VERTEX_SHADER = `
  varying vec3 vWorldDir;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldDir = normalize(position);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const SKY_FRAGMENT_SHADER = `
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform float uProgress;
  uniform float uEnergy;
  varying vec3 vWorldDir;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = p * 2.04 + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vWorldDir);
    vec3 sunN = normalize(uSunDir);
    float h = clamp(dir.y, -0.25, 1.0);
    float sunDot = max(dot(dir, sunN), 0.0);

    // Linear-space rich sunset palette -> ACES Filmic + sRGB output keeps deep saturation
    vec3 zenithCol = mix(vec3(0.008, 0.014, 0.058), vec3(0.004, 0.007, 0.036), uProgress * 0.65);
    vec3 upperCol = mix(vec3(0.135, 0.024, 0.095), vec3(0.082, 0.015, 0.072), uProgress * 0.55);
    vec3 coralCol = mix(vec3(0.68, 0.085, 0.038), vec3(0.52, 0.055, 0.032), uProgress * 0.45);
    vec3 horizonCol = mix(vec3(0.98, 0.27, 0.042), vec3(0.86, 0.16, 0.028), uProgress * 0.45);
    vec3 belowCol = vec3(0.018, 0.012, 0.028);

    vec3 col = mix(horizonCol, coralCol, smoothstep(0.0, 0.105, max(h, 0.0)));
    col = mix(col, upperCol, smoothstep(0.085, 0.29, max(h, 0.0)));
    col = mix(col, zenithCol, smoothstep(0.24, 0.72, max(h, 0.0)));
    if (h < 0.0) {
      col = mix(horizonCol, belowCol, smoothstep(-0.025, -0.22, h));
    }

    // Controlled Mie glow + crisp setting sun disc + soft upward sunset rays
    float sunGlow = pow(sunDot, 7.5) * (0.42 + uEnergy * 0.14);
    float sunCorona = pow(sunDot, 52.0) * 0.65;
    float sunCore = smoothstep(0.9977, 0.9992, sunDot);
    float rayAngle = atan(dir.x - sunN.x, max(0.001, dir.y - sunN.y));
    float crepuscular = pow(sunDot, 4.5) * smoothstep(-0.02, 0.06, dir.y) *
      (0.5 + 0.5 * sin(rayAngle * 14.0 + uTime * 0.08)) * 0.09;
    col += vec3(0.95, 0.19, 0.03) * sunGlow;
    col += vec3(1.15, 0.56, 0.14) * (sunCorona + crepuscular);
    col = mix(col, vec3(1.6, 1.18, 0.55), sunCore);

    // Domain-warped painterly sunset clouds (lit golden undersides, deep plum shadowed tops)
    if (dir.y > 0.015) {
      vec2 baseUv = dir.xz / (dir.y + 0.16);
      vec2 warp = vec2(fbm(baseUv * 0.7 + uTime * 0.008), fbm(baseUv * 0.7 - uTime * 0.006 + 4.3));
      float cloud1 = fbm(baseUv * 1.15 + warp * 0.55 + vec2(uTime * 0.011, uTime * 0.003));
      float cloudEdge = fbm(baseUv * 1.15 + warp * 0.55 + vec2(uTime * 0.011, uTime * 0.003) + vec2(0.0, 0.18));
      float mask = smoothstep(0.49, 0.77, cloud1) * smoothstep(0.015, 0.12, dir.y) * smoothstep(0.84, 0.24, dir.y);
      float underlit = smoothstep(0.0, 0.18, cloud1 - cloudEdge + 0.06);
      vec3 shadowTone = mix(vec3(0.032, 0.014, 0.055), vec3(0.22, 0.042, 0.085), pow(sunDot, 1.6));
      vec3 litTone = mix(vec3(0.58, 0.11, 0.065), vec3(1.05, 0.42, 0.085), pow(sunDot, 2.0));
      vec3 cloudCol = mix(shadowTone, litTone, underlit);
      col = mix(col, cloudCol, mask * 0.72);
    }

    // Crisp circular twinkling stars high in twilight zenith (zero square artifacts)
    if (dir.y > 0.16) {
      vec2 starSpace = dir.xz / (dir.y + 0.38) * 120.0;
      vec2 starCell = floor(starSpace);
      vec2 cellOffset = fract(starSpace) - 0.5;
      float s = hash(starCell);
      if (s > 0.986) {
        vec2 jitter = (vec2(hash(starCell + 7.1), hash(starCell + 19.3)) - 0.5) * 0.55;
        float starDot = smoothstep(0.22, 0.03, length(cellOffset - jitter));
        float twinkle = 0.55 + 0.45 * sin(uTime * (2.2 + s * 2.5) + s * 90.0);
        col += vec3(1.1, 0.92, 0.75) * starDot * smoothstep(0.16, 0.44, dir.y) * twinkle * (0.35 + uProgress * 0.45);
      }
    }

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const OCEAN_VERTEX_SHADER = `
  uniform float uTime;
  uniform float uEnergy;
  varying vec3 vWorldPos;
  varying float vWave;

  void main() {
    vec3 pos = position;
    // 4 non-aligned organic wave directions so water never looks like horizontal stripes
    float w1 = sin(dot(pos.xz, vec2(0.14, 0.11)) + uTime * 1.15);
    float w2 = sin(dot(pos.xz, vec2(-0.18, 0.24)) - uTime * 1.45) * 0.62;
    float w3 = cos(dot(pos.xz, vec2(0.08, 0.34)) + uTime * 1.85) * 0.38;
    float w4 = sin(dot(pos.xz, vec2(-0.31, -0.15)) + uTime * 1.25) * 0.28;
    float h = (w1 + w2 + w3 + w4) * (0.14 + uEnergy * 0.1);
    pos.y += h;
    vWave = h;
    vec4 worldPos = modelMatrix * vec4(pos, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const OCEAN_FRAGMENT_SHADER = `
  uniform vec3 uSunDir;
  uniform vec3 uCameraPos;
  uniform float uTime;
  uniform float uProgress;
  uniform float uBeat;
  varying vec3 vWorldPos;
  varying float vWave;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    vec2 xz = vWorldPos.xz;
    vec3 viewDir = normalize(uCameraPos - vWorldPos);
    vec3 sunN = normalize(uSunDir);

    // Multi-directional swell + capillary ripples (organic sparkling surface)
    float nx =
      cos(dot(xz, vec2(0.42, 0.28)) + uTime * 1.9) * 0.045 +
      cos(dot(xz, vec2(-0.78, 0.56)) - uTime * 2.4) * 0.035 +
      sin(dot(xz, vec2(1.45, -1.12)) + uTime * 3.1) * 0.022;
    float nz =
      cos(dot(xz, vec2(0.26, 0.68)) + uTime * 2.1) * 0.055 +
      sin(dot(xz, vec2(-0.64, 0.92)) - uTime * 2.7) * 0.038 +
      cos(dot(xz, vec2(1.18, 1.65)) - uTime * 3.5) * 0.024;
    vec3 normal = normalize(vec3(nx, 1.0, nz));

    float NdotV = max(dot(viewDir, normal), 0.0);
    float fresnel = 0.03 + 0.97 * pow(1.0 - NdotV, 4.2);

    vec3 deepTrough = vec3(0.005, 0.018, 0.048);
    vec3 crestTeal = vec3(0.012, 0.042, 0.082);
    vec3 waterBody = mix(deepTrough, crestTeal, clamp(vWave * 1.4 + 0.45, 0.0, 1.0));

    vec3 reflDir = reflect(-viewDir, normal);
    float skySun = max(dot(normalize(reflDir), sunN), 0.0);
    vec3 skyReflect = mix(vec3(0.11, 0.025, 0.075), vec3(0.88, 0.21, 0.048), pow(skySun, 2.4));
    vec3 col = mix(waterBody, skyReflect, fresnel * 0.84);

    // Crisp golden sun glitter path broken by micro-ripples
    vec3 sunRefl = reflect(-sunN, normal);
    float glitter = pow(max(dot(viewDir, sunRefl), 0.0), 120.0) * (1.8 + uBeat * 0.4);
    float broadGlow = pow(max(dot(viewDir, sunRefl), 0.0), 18.0) * 0.28;
    col += vec3(1.15, 0.52, 0.11) * (glitter + broadGlow);

    // Organic lacy surf foam breaking softly along the curving sandy cove
    float shoreZ = -79.0 + sin(xz.x * 0.04) * 9.0 - (xz.x * xz.x) * 0.0022;
    float shoreDist = abs(xz.y - shoreZ);
    float foamNoise = noise(xz * 0.32 + vec2(uTime * 0.25, -uTime * 0.4));
    float surfWave1 = smoothstep(4.2, 0.15, shoreDist + (foamNoise - 0.5) * 2.2) *
      (0.5 + 0.45 * sin(uTime * 1.75 - shoreDist * 1.9 + foamNoise * 3.0));
    float surfWave2 = smoothstep(8.5, 4.0, shoreDist + foamNoise * 2.6) *
      max(0.0, sin(uTime * 1.5 - shoreDist * 1.2)) * 0.42;
    float foam = clamp((surfWave1 + surfWave2) * (0.68 + foamNoise * 0.45), 0.0, 0.88);
    col = mix(col, vec3(0.92, 0.68, 0.50), foam);

    // Seamless sunset horizon mist fade matching SKY_FRAGMENT_SHADER horizonCol
    vec3 horizonCol = mix(vec3(0.98, 0.27, 0.042), vec3(0.86, 0.16, 0.028), uProgress * 0.45);
    float dist = length(xz);
    float fog = smoothstep(130.0, 440.0, dist);
    col = mix(col, horizonCol, fog);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const BEACH_VERTEX_SHADER = `
  varying vec3 vWorldPos;
  varying float vLocalZ;
  void main() {
    vLocalZ = position.z;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const BEACH_FRAGMENT_SHADER = `
  uniform vec3 uSunDir;
  uniform vec3 uCameraPos;
  uniform float uTime;
  varying vec3 vWorldPos;
  varying float vLocalZ;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    vec2 xz = vWorldPos.xz;
    float shoreZ = -79.0 + sin(xz.x * 0.04) * 9.0 - (xz.x * xz.x) * 0.0022;
    float inlandDist = max(0.0, xz.y - shoreZ);
    float inland = clamp(inlandDist / 52.0, 0.0, 1.0);

    // Wind-rippled sand relief merging seamlessly into coastal cliff scrub inland
    float grain = noise(xz * 2.8) * 0.045 + noise(xz * 11.0) * 0.02;
    float ripple = sin(xz.y * 1.4 + noise(xz * 0.25) * 4.0) * 0.024;
    vec3 wetSand = vec3(0.088, 0.038, 0.022);
    vec3 drySand = vec3(0.42, 0.20, 0.082) + ripple * 0.22 + (grain - 0.03) * 0.38;
    vec3 coastalScrub = vec3(0.068, 0.038, 0.032) + grain * 0.18;

    float wetness = smoothstep(-2.0, 8.5, xz.y - shoreZ);
    vec3 col = mix(wetSand, drySand, wetness);
    col = mix(col, coastalScrub, smoothstep(0.36, 0.88, inland));

    // Warm sunset specular reflection across wet tide flat
    vec3 viewDir = normalize(uCameraPos - vWorldPos);
    vec3 normal = normalize(vec3((noise(xz * 1.2) - 0.5) * 0.08, 1.0, 0.04));
    vec3 refl = reflect(-normalize(uSunDir), normal);
    float wetSpec = pow(max(dot(viewDir, refl), 0.0), 36.0) * (1.0 - wetness * 0.88);
    col += vec3(0.92, 0.32, 0.08) * wetSpec * 0.45;

    // Subtle distance atmospheric haze
    float dist = length(xz);
    float fog = smoothstep(80.0, 195.0, dist);
    col = mix(col, vec3(0.54, 0.14, 0.06), fog * 0.58);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const HEADLAND_VERTEX_SHADER = `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const HEADLAND_FRAGMENT_SHADER = `
  uniform vec3 uSunDir;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    vec3 sunN = normalize(uSunDir);
    vec3 n = normalize(vWorldNormal);
    float sunWrap = clamp(dot(n, sunN) * 0.5 + 0.5, 0.0, 1.0);
    float heightFactor = smoothstep(-14.0, 3.0, vWorldPos.y);

    vec3 shadowCol = mix(vec3(0.012, 0.010, 0.026), vec3(0.028, 0.016, 0.042), heightFactor);
    vec3 ridgeWarm = vec3(0.36, 0.075, 0.048);
    vec3 col = mix(shadowCol, ridgeWarm, pow(sunWrap, 2.2) * (0.35 + heightFactor * 0.45));

    // Distance sunset aerial perspective
    float dist = length(vWorldPos.xz);
    float haze = smoothstep(55.0, 165.0, dist);
    col = mix(col, vec3(0.42, 0.10, 0.075), haze * 0.62);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const PAPER_VERTEX_SHADER = `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const PAPER_FRAGMENT_SHADER = `
  uniform sampler2D uPaperMap;
  uniform vec3 uLanternPos;
  uniform float uLanternFlicker;
  varying vec2 vUv;
  varying vec3 vWorldPos;

  float paperHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float paperGrain(vec2 uv) {
    vec2 p = uv * vec2(390.0, 552.0);
    float n1 = paperHash(floor(p));
    float n2 = paperHash(floor(p * 0.5 + 17.3));
    return (n1 * 0.65 + n2 * 0.35) - 0.5;
  }

  void main() {
    vec3 tex = texture2D(uPaperMap, vUv).rgb;
    vec3 col = pow(max(tex, vec3(0.0)), vec3(1.08));
    col += paperGrain(vUv) * 0.01;

    vec2 centered = (vUv - 0.5) * vec2(1.15, 1.0);
    float edge = dot(centered, centered);
    col *= 1.0 - edge * 0.12;

    float d = length(uLanternPos - vWorldPos);
    float lanternGlow = (1.0 / (1.0 + d * d * 22.0)) * (0.032 + uLanternFlicker * 0.015);
    col += col * vec3(1.0, 0.68, 0.34) * lanternGlow;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    #include <colorspace_fragment>
  }
`;

function createDriftwoodTextures(): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const albedo = document.createElement("canvas");
  albedo.width = 512;
  albedo.height = 512;
  const ctx = albedo.getContext("2d")!;

  const bump = document.createElement("canvas");
  bump.width = 512;
  bump.height = 512;
  const btx = bump.getContext("2d")!;

  ctx.fillStyle = "#523828";
  ctx.fillRect(0, 0, 512, 512);
  btx.fillStyle = "#808080";
  btx.fillRect(0, 0, 512, 512);

  // Subtle plank seams + warm weathered grain streaks
  for (let i = 0; i < 420; i += 1) {
    const h = Math.sin(i * 19.37 + 3.1) * 43758.5453;
    const f = h - Math.floor(h);
    const y = (i / 420) * 512 + (f - 0.5) * 3;
    const tone = f > 0.5 ? "rgba(116, 79, 54, 0.24)" : "rgba(38, 24, 17, 0.28)";
    ctx.strokeStyle = tone;
    ctx.lineWidth = 0.8 + f * 2.2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(170, y + (f - 0.5) * 14, 340, y - (f - 0.5) * 14, 512, y);
    ctx.stroke();

    btx.strokeStyle = f > 0.5 ? "rgba(210, 210, 210, 0.22)" : "rgba(65, 65, 65, 0.24)";
    btx.lineWidth = 1.0 + f * 1.8;
    btx.beginPath();
    btx.moveTo(0, y);
    btx.lineTo(512, y);
    btx.stroke();
  }

  for (let p = 1; p < 4; p += 1) {
    const py = p * 128;
    ctx.fillStyle = "rgba(22, 14, 10, 0.45)";
    ctx.fillRect(0, py - 2, 512, 4);
    btx.fillStyle = "rgba(25, 25, 25, 0.85)";
    btx.fillRect(0, py - 2, 512, 4);
  }

  const map = new THREE.CanvasTexture(albedo);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  const bumpMap = new THREE.CanvasTexture(bump);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;
  return { map, bumpMap };
}

function createGraniteTextures(): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const albedo = document.createElement("canvas");
  albedo.width = 256;
  albedo.height = 256;
  const ctx = albedo.getContext("2d")!;

  const bump = document.createElement("canvas");
  bump.width = 256;
  bump.height = 256;
  const btx = bump.getContext("2d")!;

  ctx.fillStyle = "#46383f";
  ctx.fillRect(0, 0, 256, 256);
  btx.fillStyle = "#808080";
  btx.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 650; i += 1) {
    const s1 = Math.sin(i * 12.9898 + 1.3) * 43758.5453;
    const s2 = Math.sin(i * 78.233 + 5.7) * 43758.5453;
    const f1 = s1 - Math.floor(s1);
    const f2 = s2 - Math.floor(s2);
    const x = f1 * 256;
    const y = f2 * 256;
    const r = 3 + ((i * 7) % 14);
    ctx.fillStyle = i % 3 === 0 ? "rgba(98, 76, 75, 0.3)" : "rgba(38, 30, 42, 0.28)";
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.4, r * 0.7, f1 * 3.14, 0, Math.PI * 2);
    ctx.fill();

    btx.fillStyle = i % 2 === 0 ? "rgba(180, 180, 180, 0.26)" : "rgba(70, 70, 70, 0.26)";
    btx.beginPath();
    btx.ellipse(x, y, r * 1.3, r * 0.65, f1 * 3.14, 0, Math.PI * 2);
    btx.fill();
  }

  const map = new THREE.CanvasTexture(albedo);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(4, 3);
  const bumpMap = new THREE.CanvasTexture(bump);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.repeat.set(4, 3);
  return { map, bumpMap };
}

function createSoftGlowSpriteTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255, 250, 225, 1)");
  grad.addColorStop(0.28, "rgba(255, 206, 118, 0.82)");
  grad.addColorStop(0.65, "rgba(244, 134, 58, 0.24)");
  grad.addColorStop(1, "rgba(244, 134, 58, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class SunsetCliffWorld {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly paperTexture: THREE.CanvasTexture;
  readonly paperMesh: THREE.Mesh;
  readonly paperTransform: PaperTransform;

  private readonly skyUniforms: {
    uSunDir: { value: THREE.Vector3 };
    uTime: { value: number };
    uProgress: { value: number };
    uEnergy: { value: number };
  };
  private readonly oceanUniforms: {
    uSunDir: { value: THREE.Vector3 };
    uCameraPos: { value: THREE.Vector3 };
    uTime: { value: number };
    uProgress: { value: number };
    uEnergy: { value: number };
    uBeat: { value: number };
  };
  private readonly beachUniforms: {
    uSunDir: { value: THREE.Vector3 };
    uCameraPos: { value: THREE.Vector3 };
    uTime: { value: number };
  };
  private readonly headlandUniforms: {
    uSunDir: { value: THREE.Vector3 };
  };
  private readonly paperUniforms: {
    uPaperMap: { value: THREE.CanvasTexture };
    uLanternPos: { value: THREE.Vector3 };
    uLanternFlicker: { value: number };
  };

  private readonly lanternLight: THREE.PointLight;
  private readonly lanternHalo: THREE.Sprite;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly baseCameraPos = new THREE.Vector3(0, 1.5, 0.38);
  private readonly baseLookTarget = new THREE.Vector3(0, -0.9, -9.62);
  private readonly ambientFireflies: THREE.Points;
  private readonly ambientFireflyBase: Float32Array;
  private readonly pineTrees: Array<{ group: THREE.Group; phase: number; baseZRot: number }> = [];
  private readonly coastalBirds: Array<{
    group: THREE.Group;
    wingL: THREE.Mesh;
    wingR: THREE.Mesh;
    phase: number;
    speed: number;
    radiusX: number;
    radiusZ: number;
    baseY: number;
  }> = [];
  private streakIntensity = 0;
  private hapticImpulse = 0;
  private lastElapsed = 0;
  private pointerX = 0;
  private pointerY = 0;

  constructor(paperCanvas: HTMLCanvasElement, aspect: number) {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x6c3844, 0.0026);

    this.camera = new THREE.PerspectiveCamera(56, aspect, 0.05, 720);
    this.camera.position.copy(this.baseCameraPos);
    this.camera.lookAt(this.baseLookTarget);

    const sunDir = new THREE.Vector3(0.14, 0.14, -1.0).normalize();
    const glowSpriteTex = createSoftGlowSpriteTexture();

    // 1. Sunset Sky Dome
    this.skyUniforms = {
      uSunDir: { value: sunDir.clone() },
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uEnergy: { value: 0.2 },
    };
    const skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(540, 48, 32),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERTEX_SHADER,
        fragmentShader: SKY_FRAGMENT_SHADER,
        uniforms: this.skyUniforms,
        side: THREE.BackSide,
        depthWrite: false,
        toneMapped: true,
      }),
    );
    this.scene.add(skyDome);

    // 2. Organic Multi-Directional Sunset Ocean below the cliff
    this.oceanUniforms = {
      uSunDir: { value: sunDir.clone() },
      uCameraPos: { value: this.baseCameraPos.clone() },
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uEnergy: { value: 0.2 },
      uBeat: { value: 0 },
    };
    const oceanGeo = new THREE.PlaneGeometry(600, 480, 104, 84);
    oceanGeo.rotateX(-Math.PI / 2);
    const ocean = new THREE.Mesh(
      oceanGeo,
      new THREE.ShaderMaterial({
        vertexShader: OCEAN_VERTEX_SHADER,
        fragmentShader: OCEAN_FRAGMENT_SHADER,
        uniforms: this.oceanUniforms,
        toneMapped: true,
      }),
    );
    ocean.position.set(0, -14.0, -280);
    this.scene.add(ocean);

    // 3. Curving Sandy Beach Shoreline & Atmospheric Coastal Headlands
    this.beachUniforms = {
      uSunDir: { value: sunDir.clone() },
      uCameraPos: { value: this.baseCameraPos.clone() },
      uTime: { value: 0 },
    };
    this.headlandUniforms = {
      uSunDir: { value: sunDir.clone() },
    };
    this.buildBeachAndHeadlands();

    // 4. Lighting & Cliff Edge (with Procedural Driftwood & Granite PBR Textures)
    const hemi = new THREE.HemisphereLight(0xffe1c2, 0x261e34, 0.72);
    this.scene.add(hemi);

    this.sunLight = new THREE.DirectionalLight(0xffa159, 1.35);
    this.sunLight.position.copy(sunDir).multiplyScalar(60);
    this.scene.add(this.sunLight);

    const cliffBounceLight = new THREE.DirectionalLight(0xc27060, 0.35);
    cliffBounceLight.position.set(2.5, 2.2, 1.8);
    this.scene.add(cliffBounceLight);

    const lanternWorldPos = new THREE.Vector3(-0.37, 0.945, -0.47);
    this.lanternLight = new THREE.PointLight(0xffb45a, 0.9, 2.8);
    this.lanternLight.position.set(-0.37, 1.1, -0.47);
    this.scene.add(this.lanternLight);

    this.lanternHalo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowSpriteTex,
        color: 0xffba5c,
        transparent: true,
        opacity: 0.45,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.lanternHalo.position.copy(lanternWorldPos);
    this.lanternHalo.scale.set(0.24, 0.24, 1);
    this.scene.add(this.lanternHalo);

    this.buildCliffEdge(glowSpriteTex);

    // 5. A4 Portrait Sketchbook Paper + Leather Journal Stack in 1st-person foreground
    this.paperTexture = new THREE.CanvasTexture(paperCanvas);
    this.paperTexture.colorSpace = THREE.SRGBColorSpace;
    this.paperTexture.generateMipmaps = true;
    this.paperTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.paperTexture.magFilter = THREE.LinearFilter;
    this.paperTexture.anisotropy = 8;

    const paperWidth = 0.34;
    const paperHeight = paperWidth * 1.4142; // Exact A4 portrait proportion
    const paperCenter = new THREE.Vector3(0, 1.095, -0.55);
    const paperTiltX = -Math.PI / 2 + 0.9; // Full-sheet view without bottom clipping

    // Dark walnut leather journal cover
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(paperWidth + 0.044, paperHeight + 0.038, 0.012),
      new THREE.MeshStandardMaterial({ color: 0x2f1e18, roughness: 0.78, metalness: 0.1 }),
    );
    board.position.copy(paperCenter);
    board.rotation.x = paperTiltX;
    board.translateZ(-0.0125);
    this.scene.add(board);

    // Stacked sketchbook page block cleanly recessed >= 3mm behind paperMesh
    const pageStack = new THREE.Mesh(
      new THREE.BoxGeometry(paperWidth + 0.004, paperHeight + 0.004, 0.005),
      new THREE.MeshStandardMaterial({ color: 0xddd2bd, roughness: 0.92, metalness: 0.0 }),
    );
    pageStack.position.copy(paperCenter);
    pageStack.rotation.x = paperTiltX;
    pageStack.translateZ(-0.0055);
    this.scene.add(pageStack);

    // Brass top journal clip keeping the top page flush
    const clipMat = new THREE.MeshStandardMaterial({ color: 0xb68a46, metalness: 0.78, roughness: 0.28 });
    const topClip = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.012, 0.008), clipMat);
    topClip.position.copy(paperCenter);
    topClip.rotation.x = paperTiltX;
    topClip.translateY(paperHeight * 0.5 + 0.005);
    topClip.translateZ(0.0025);
    this.scene.add(topClip);

    this.paperUniforms = {
      uPaperMap: { value: this.paperTexture },
      uLanternPos: { value: lanternWorldPos },
      uLanternFlicker: { value: 0 },
    };

    // Dedicated toneMapped:false paper shader preserves Living Sketchbook watercolor contrast
    this.paperMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(paperWidth, paperHeight, 12, 16),
      new THREE.ShaderMaterial({
        vertexShader: PAPER_VERTEX_SHADER,
        fragmentShader: PAPER_FRAGMENT_SHADER,
        uniforms: this.paperUniforms,
        toneMapped: false,
      }),
    );
    const posAttr = this.paperMesh.geometry.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const px = posAttr.getX(i);
      const py = posAttr.getY(i);
      const curl =
        Math.pow(Math.abs(px) / (paperWidth * 0.5), 2) * 0.0018 +
        Math.cos((py / paperHeight) * Math.PI) * 0.0012;
      posAttr.setZ(i, curl);
    }
    this.paperMesh.geometry.computeVertexNormals();
    this.paperMesh.position.copy(paperCenter);
    this.paperMesh.rotation.x = paperTiltX;
    this.scene.add(this.paperMesh);

    const quat = new THREE.Quaternion().setFromEuler(this.paperMesh.rotation);
    this.paperTransform = {
      center: paperCenter.clone(),
      normal: new THREE.Vector3(0, 0, 1).applyQuaternion(quat).normalize(),
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize(),
      up: new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize(),
      width: paperWidth,
      height: paperHeight,
    };

    // 6. Soft circular additive ambient cliffside fireflies (no white squares!)
    const ambientCount = 22;
    this.ambientFireflyBase = new Float32Array(ambientCount * 3);
    const positions = new Float32Array(ambientCount * 3);
    for (let i = 0; i < ambientCount; i += 1) {
      const side = i % 2 === 0 ? -1 : 1;
      const bx = side * (1.35 + ((i * 37) % 19) * 0.14);
      const by = 0.95 + ((i * 53) % 21) * 0.075;
      const bz = -1.35 - ((i * 29) % 17) * 0.24;
      this.ambientFireflyBase[i * 3] = bx;
      this.ambientFireflyBase[i * 3 + 1] = by;
      this.ambientFireflyBase[i * 3 + 2] = bz;
      positions[i * 3] = bx;
      positions[i * 3 + 1] = by;
      positions[i * 3 + 2] = bz;
    }
    const ambientGeo = new THREE.BufferGeometry();
    ambientGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.ambientFireflies = new THREE.Points(
      ambientGeo,
      new THREE.PointsMaterial({
        map: glowSpriteTex,
        color: 0xffc864,
        size: 0.11,
        transparent: true,
        opacity: 0.68,
        alphaTest: 0.01,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.scene.add(this.ambientFireflies);

    // 7. Distant coastal seabirds soaring slowly over the sunset ocean
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x241926, side: THREE.DoubleSide });
    const birdWingGeo = new THREE.PlaneGeometry(0.65, 0.14);
    for (let i = 0; i < 3; i += 1) {
      const group = new THREE.Group();
      const wingL = new THREE.Mesh(birdWingGeo, birdMat);
      wingL.position.x = -0.32;
      const wingR = new THREE.Mesh(birdWingGeo, birdMat);
      wingR.position.x = 0.32;
      group.add(wingL, wingR);
      this.scene.add(group);
      this.coastalBirds.push({
        group,
        wingL,
        wingR,
        phase: i * 2.1,
        speed: 0.14 + i * 0.035,
        radiusX: 18 + i * 7,
        radiusZ: 9 + i * 4,
        baseY: -4.2 + i * 1.4,
      });
    }
  }

  private buildBeachAndHeadlands() {
    // Sweeping sandy cove extending continuously inland beneath the cliff ledge (zero sky gap)
    const beachGeo = new THREE.PlaneGeometry(280, 96, 72, 28);
    beachGeo.rotateX(-Math.PI / 2);
    const pos = beachGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const curve = Math.sin(x * 0.04) * 9.0 - (x * x) * 0.0022;
      pos.setZ(i, z + curve);
      const slope = (z + 29) * 0.11;
      pos.setY(i, Math.max(-2.0, slope));
    }
    beachGeo.computeVertexNormals();
    const beach = new THREE.Mesh(
      beachGeo,
      new THREE.ShaderMaterial({
        vertexShader: BEACH_VERTEX_SHADER,
        fragmentShader: BEACH_FRAGMENT_SHADER,
        uniforms: this.beachUniforms,
        toneMapped: true,
      }),
    );
    beach.position.set(0, -14.1, -50);
    this.scene.add(beach);

    // Multi-ridge coastal mountain headlands with sunset rim light
    const headlandMat = new THREE.ShaderMaterial({
      vertexShader: HEADLAND_VERTEX_SHADER,
      fragmentShader: HEADLAND_FRAGMENT_SHADER,
      uniforms: this.headlandUniforms,
      toneMapped: true,
    });
    const specs = [
      { x: -46, y: -11, z: -76, rx: 24, ry: 13, rz: 20 },
      { x: 52, y: -10, z: -82, rx: 27, ry: 14, rz: 22 },
      { x: -80, y: -8.5, z: -118, rx: 35, ry: 18, rz: 28 },
      { x: 86, y: -7.5, z: -124, rx: 38, ry: 19, rz: 30 },
    ];
    for (const s of specs) {
      const geo = new THREE.ConeGeometry(1, 1, 16, 6);
      const pAttr = geo.attributes.position;
      for (let i = 0; i < pAttr.count; i += 1) {
        const vx = pAttr.getX(i);
        const vy = pAttr.getY(i);
        const vz = pAttr.getZ(i);
        const ridge = 1 + Math.sin(vx * 5.2 + vz * 3.7 + s.x) * 0.18 + Math.cos(vy * 6.0 + vx * 2.4) * 0.1;
        pAttr.setXYZ(i, vx * ridge, vy, vz * ridge);
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, headlandMat);
      m.position.set(s.x, s.y, s.z);
      m.scale.set(s.rx, s.ry, s.rz);
      m.rotation.y = s.x * 0.1;
      this.scene.add(m);
    }
  }

  private buildCliffEdge(_glowTex: THREE.CanvasTexture) {
    const granite = createGraniteTextures();
    const cliffMat = new THREE.MeshStandardMaterial({
      map: granite.map,
      bumpMap: granite.bumpMap,
      bumpScale: 0.045,
      roughness: 0.92,
      metalness: 0.04,
    });

    const stoneLedge = new THREE.Mesh(new THREE.BoxGeometry(5.8, 16, 2.3), cliffMat);
    stoneLedge.position.set(0, -7.14, -0.18);
    this.scene.add(stoneLedge);

    // Craggy tessellated cliff boulders framing left & right perimeter
    const rockSpecs = [
      [-1.78, 0.72, -1.85, 0.92, 0.44, 0.82],
      [1.9, 0.68, -1.95, 1.02, 0.46, 0.86],
      [-2.85, -0.4, -3.7, 1.55, 1.2, 1.45],
      [2.95, -0.58, -4.0, 1.72, 1.3, 1.52],
      [0.0, -3.85, -5.3, 4.9, 3.4, 2.8],
    ];
    for (const [x, y, z, sx, sy, sz] of rockSpecs) {
      const rockGeo = new THREE.DodecahedronGeometry(1, 2);
      const rPos = rockGeo.attributes.position;
      for (let i = 0; i < rPos.count; i += 1) {
        const vx = rPos.getX(i);
        const vy = rPos.getY(i);
        const vz = rPos.getZ(i);
        const crag = 0.88 + 0.22 * Math.sin(vx * 3.7 + x) * Math.cos(vy * 4.1 + z) + 0.08 * Math.sin(vz * 6.3);
        rPos.setXYZ(i, vx * crag, vy * crag, vz * crag);
      }
      rockGeo.computeVertexNormals();
      const rock = new THREE.Mesh(rockGeo, cliffMat);
      rock.position.set(x, y, z);
      rock.scale.set(sx, sy, sz);
      rock.rotation.set(x * 0.3, z * 0.4, 0.2);
      this.scene.add(rock);
    }

    // Weathered driftwood desk with procedural wood grain & bump
    const wood = createDriftwoodTextures();
    const woodMat = new THREE.MeshStandardMaterial({
      map: wood.map,
      bumpMap: wood.bumpMap,
      bumpScale: 0.015,
      roughness: 0.84,
      metalness: 0.04,
    });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.05, 0.62), woodMat);
    desk.position.set(0, 0.86, -0.49);
    this.scene.add(desk);

    // Warm brass lantern with vertical protective cage ribs on left edge
    const brassMat = new THREE.MeshStandardMaterial({ color: 0x6b5034, metalness: 0.72, roughness: 0.36 });
    const lanternBase = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.042, 0.025, 16), brassMat);
    lanternBase.position.set(-0.37, 0.898, -0.47);
    this.scene.add(lanternBase);

    const lanternGlass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.026, 0.026, 0.07, 16),
      new THREE.MeshStandardMaterial({
        color: 0xffd796,
        emissive: 0xff9830,
        emissiveIntensity: 1.35,
        roughness: 0.2,
      }),
    );
    lanternGlass.position.set(-0.37, 0.945, -0.47);
    this.scene.add(lanternGlass);

    for (let r = 0; r < 4; r += 1) {
      const ang = (r / 4) * Math.PI * 2 + Math.PI / 4;
      const rib = new THREE.Mesh(new THREE.CylinderGeometry(0.0018, 0.0018, 0.072, 6), brassMat);
      rib.position.set(-0.37 + Math.cos(ang) * 0.029, 0.945, -0.47 + Math.sin(ang) * 0.029);
      this.scene.add(rib);
    }

    const lanternCap = new THREE.Mesh(new THREE.ConeGeometry(0.041, 0.036, 16), brassMat);
    lanternCap.position.set(-0.37, 0.996, -0.47);
    this.scene.add(lanternCap);

    // Smooth coastal pine silhouettes with sunset warmth & gentle breeze sway
    const pineMat = new THREE.MeshStandardMaterial({
      color: 0x1b2621,
      emissive: 0x1b0d09,
      emissiveIntensity: 0.25,
      roughness: 0.92,
    });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x38261d, roughness: 0.94 });
    const treePositions = [
      [-2.62, 0.72, -2.05, 1.08],
      [-3.38, 0.26, -3.25, 1.35],
      [2.68, 0.68, -2.2, 1.05],
      [3.42, 0.12, -3.5, 1.4],
    ];
    for (const [x, y, z, scale] of treePositions) {
      const treeGroup = new THREE.Group();
      treeGroup.position.set(x, y, z);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * scale, 0.085 * scale, 0.95 * scale, 10), trunkMat);
      trunk.position.set(0, 0.4 * scale, 0);
      treeGroup.add(trunk);
      for (let tier = 0; tier < 4; tier += 1) {
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry((0.48 - tier * 0.09) * scale, 0.58 * scale, 12),
          pineMat,
        );
        cone.position.set(0, (0.82 + tier * 0.34) * scale, 0);
        treeGroup.add(cone);
      }
      this.scene.add(treeGroup);
      this.pineTrees.push({ group: treeGroup, phase: x * 1.1 + z * 0.7, baseZRot: (x < 0 ? 1 : -1) * 0.025 });
    }
  }

  /** Converts normalized A4 paper coordinates (u in [0..1], v in [0..1] top-down) into 3D world space. */
  paperUvToWorld(u: number, v: number, liftAlongNormal = 0.012): THREE.Vector3 {
    const localX = (u - 0.5) * this.paperTransform.width;
    const localY = (0.5 - v) * this.paperTransform.height;
    return this.paperTransform.center
      .clone()
      .addScaledVector(this.paperTransform.right, localX)
      .addScaledVector(this.paperTransform.up, localY)
      .addScaledVector(this.paperTransform.normal, liftAlongNormal);
  }

  setStreakIntensity(intensity01: number) {
    this.streakIntensity = Math.max(0, Math.min(1, intensity01));
  }

  /** Subtle tactile micro-haptic impulse on near-beat catches (gentle camera breath + warm lantern glow). */
  triggerMicroHaptic(intensity01: number) {
    this.hapticImpulse = Math.max(this.hapticImpulse, Math.max(0, Math.min(1, intensity01)));
  }

  setPointerParallax(ndcX: number, ndcY: number) {
    this.pointerX = Math.max(-1, Math.min(1, ndcX));
    this.pointerY = Math.max(-1, Math.min(1, ndcY));
  }

  resize(width: number, height: number) {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  update(elapsedSeconds: number, frame: MusicLyricFrame) {
    this.paperTexture.needsUpdate = true;
    const dt = this.lastElapsed > 0 ? Math.min(0.1, Math.max(0, elapsedSeconds - this.lastElapsed)) : 0.016;
    this.lastElapsed = elapsedSeconds;
    this.hapticImpulse *= Math.exp(-dt * 14);
    if (this.hapticImpulse < 0.002) this.hapticImpulse = 0;

    const sunY = 0.16 - frame.progress * 0.095;
    const sunX = -0.18 + frame.progress * 0.36;
    const sunDir = new THREE.Vector3(sunX, sunY, -1.0).normalize();

    this.skyUniforms.uSunDir.value.copy(sunDir);
    this.skyUniforms.uTime.value = elapsedSeconds;
    this.skyUniforms.uProgress.value = frame.progress;
    this.skyUniforms.uEnergy.value = frame.energy;

    this.oceanUniforms.uSunDir.value.copy(sunDir);
    this.oceanUniforms.uTime.value = elapsedSeconds;
    this.oceanUniforms.uProgress.value = frame.progress;
    this.oceanUniforms.uEnergy.value = frame.energy;
    this.oceanUniforms.uBeat.value = frame.beat;

    this.beachUniforms.uSunDir.value.copy(sunDir);
    this.beachUniforms.uTime.value = elapsedSeconds;
    this.headlandUniforms.uSunDir.value.copy(sunDir);

    const flicker = Math.sin(elapsedSeconds * 5.2) * 0.5 + Math.cos(elapsedSeconds * 11.4) * 0.25 + frame.beat * 0.5;
    this.paperUniforms.uLanternFlicker.value = flicker + this.hapticImpulse * 0.45;

    this.sunLight.position.copy(sunDir).multiplyScalar(60);
    this.lanternLight.intensity = 0.85 + flicker * 0.12 + this.streakIntensity * 0.2 + this.hapticImpulse * 0.18;
    this.lanternHalo.scale.setScalar(
      0.22 + flicker * 0.025 + this.streakIntensity * 0.04 + this.hapticImpulse * 0.032,
    );

    // Subtle pine breeze sway
    for (const tree of this.pineTrees) {
      tree.group.rotation.z =
        tree.baseZRot + Math.sin(elapsedSeconds * 0.85 + tree.phase) * (0.015 + frame.air * 0.012);
    }

    // Drift ambient cliffside fireflies softly in peripheral space
    const posAttr = this.ambientFireflies.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < posAttr.count; i += 1) {
      const bx = this.ambientFireflyBase[i * 3];
      const by = this.ambientFireflyBase[i * 3 + 1];
      const bz = this.ambientFireflyBase[i * 3 + 2];
      posAttr.setXYZ(
        i,
        bx + Math.sin(elapsedSeconds * 0.7 + i * 1.3) * 0.25,
        by + Math.cos(elapsedSeconds * 0.9 + i * 1.7) * 0.16,
        bz + Math.sin(elapsedSeconds * 0.5 + i * 0.9) * 0.22,
      );
    }
    posAttr.needsUpdate = true;
    const ambMat = this.ambientFireflies.material as THREE.PointsMaterial;
    ambMat.opacity = 0.52 + this.streakIntensity * 0.32 + frame.beat * 0.16;

    // Soaring coastal seabirds gliding above the shoreline
    for (const bird of this.coastalBirds) {
      const a = elapsedSeconds * bird.speed + bird.phase;
      const x = Math.sin(a) * bird.radiusX;
      const z = -54 + Math.sin(a * 2) * bird.radiusZ;
      const y = bird.baseY + Math.cos(a * 1.5) * 0.85;
      bird.group.position.set(x, y, z);
      bird.group.rotation.y = Math.atan2(Math.cos(a) * bird.radiusX, 2 * Math.cos(a * 2) * bird.radiusZ);
      const flap = Math.sin(elapsedSeconds * 5.2 + bird.phase) * 0.35;
      bird.wingL.rotation.z = flap;
      bird.wingR.rotation.z = -flap;
    }

    // Subtle 1st-person look parallax that keeps the A4 paper cleanly framed
    const targetLook = this.baseLookTarget.clone();
    targetLook.x += this.pointerX * 0.55;
    targetLook.y += this.pointerY * 0.38;
    this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, this.pointerX * 0.035, 0.08);
    this.camera.position.y = THREE.MathUtils.lerp(
      this.camera.position.y,
      this.baseCameraPos.y +
        this.pointerY * 0.02 +
        Math.sin(elapsedSeconds * 0.9) * 0.003 -
        this.hapticImpulse * 0.0022,
      0.08,
    );
    this.camera.lookAt(targetLook);
    this.oceanUniforms.uCameraPos.value.copy(this.camera.position);
    this.beachUniforms.uCameraPos.value.copy(this.camera.position);
  }
}
