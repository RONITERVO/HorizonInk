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
    for (int i = 0; i < 4; i++) {
      v += a * noise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vWorldDir);
    float h = clamp(dir.y, -0.2, 1.0);
    float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);

    // Rich coastal sunset gradient evolving slightly toward twilight with song progress
    vec3 zenithCol = mix(vec3(0.09, 0.13, 0.28), vec3(0.05, 0.07, 0.19), uProgress * 0.6);
    vec3 midCol = mix(vec3(0.55, 0.27, 0.42), vec3(0.38, 0.19, 0.36), uProgress * 0.5);
    vec3 horizonCol = mix(vec3(0.97, 0.58, 0.30), vec3(0.92, 0.42, 0.25), uProgress * 0.45);
    vec3 belowCol = vec3(0.18, 0.15, 0.22);

    vec3 col = mix(horizonCol, midCol, smoothstep(0.0, 0.24, max(h, 0.0)));
    col = mix(col, zenithCol, smoothstep(0.18, 0.72, max(h, 0.0)));
    if (h < 0.0) {
      col = mix(horizonCol * 0.75, belowCol, smoothstep(0.0, -0.18, h));
    }

    // Broad sunset bloom around the sun
    float sunGlow = pow(sunDot, 5.0) * (0.45 + uEnergy * 0.15);
    float sunCore = smoothstep(0.9965, 0.9992, sunDot);
    float sunCorona = pow(sunDot, 42.0) * 0.75;
    col += vec3(1.0, 0.62, 0.28) * sunGlow;
    col += vec3(1.0, 0.85, 0.55) * sunCorona;
    col = mix(col, vec3(1.0, 0.96, 0.84), sunCore);

    // Soft glowing sunset clouds
    if (dir.y > 0.02) {
      vec2 cloudUv = dir.xz / (dir.y + 0.18) * 1.4 + vec2(uTime * 0.012, uTime * 0.004);
      float c = fbm(cloudUv);
      float cloudMask = smoothstep(0.47, 0.78, c) * smoothstep(0.02, 0.14, dir.y) * smoothstep(0.85, 0.25, dir.y);
      vec3 cloudBase = mix(vec3(0.45, 0.25, 0.38), vec3(0.99, 0.72, 0.44), pow(sunDot, 2.2));
      col = mix(col, cloudBase, cloudMask * 0.55);
    }

    // Subtle twilight stars high in the dome
    if (dir.y > 0.18) {
      vec2 starGrid = floor(dir.xz / (dir.y + 0.4) * 160.0);
      float s = hash(starGrid);
      if (s > 0.993) {
        float twinkle = 0.5 + 0.5 * sin(uTime * 2.5 + s * 100.0);
        col += vec3(1.0, 0.95, 0.88) * smoothstep(0.18, 0.45, dir.y) * twinkle * (0.35 + uProgress * 0.5);
      }
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

const OCEAN_VERTEX_SHADER = `
  uniform float uTime;
  uniform float uEnergy;
  varying vec3 vWorldPos;
  varying float vWave;

  void main() {
    vec3 pos = position;
    float w1 = sin(pos.x * 0.16 + uTime * 1.2) * cos(pos.z * 0.12 + uTime * 0.9);
    float w2 = sin(pos.x * 0.35 - uTime * 1.6 + pos.z * 0.22) * 0.45;
    float height = (w1 + w2) * (0.16 + uEnergy * 0.12);
    pos.y += height;
    vWave = height;
    vec4 worldPos = modelMatrix * vec4(pos, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const OCEAN_FRAGMENT_SHADER = `
  uniform vec3 uSunDir;
  uniform vec3 uCameraPos;
  uniform float uTime;
  uniform float uBeat;
  varying vec3 vWorldPos;
  varying float vWave;

  void main() {
    vec3 viewDir = normalize(uCameraPos - vWorldPos);
    // Analytic water micro-normal for crisp sunset shimmer path
    float nx = sin(vWorldPos.x * 0.9 + uTime * 2.1) * 0.08 + cos(vWorldPos.z * 0.7 - uTime * 1.7) * 0.06;
    float nz = cos(vWorldPos.z * 1.2 + uTime * 2.4) * 0.09 + sin(vWorldPos.x * 0.5 + uTime * 1.3) * 0.05;
    vec3 normal = normalize(vec3(nx, 1.0, nz));

    float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 3.4);
    vec3 deepWater = vec3(0.06, 0.14, 0.24);
    vec3 skyReflect = vec3(0.68, 0.34, 0.38);
    vec3 col = mix(deepWater, skyReflect, fresnel * 0.78);

    // Golden solar glitter ribbon across the ocean
    vec3 refl = reflect(-normalize(uSunDir), normal);
    float spec = pow(max(dot(viewDir, refl), 0.0), 48.0);
    float broadSpec = pow(max(dot(viewDir, refl), 0.0), 8.0) * 0.35;
    col += vec3(1.0, 0.74, 0.34) * (spec * (1.25 + uBeat * 0.35) + broadSpec);

    // Shoreline foam where water meets the visible curving beach below the cliff (z near -64..-78)
    float shoreZ = -66.0 + sin(vWorldPos.x * 0.045) * 8.0 - (vWorldPos.x * vWorldPos.x) * 0.0025;
    float shoreDist = abs(vWorldPos.z - shoreZ);
    float foamBand = smoothstep(4.5, 0.3, shoreDist) * (0.55 + 0.35 * sin(uTime * 1.9 - shoreDist * 1.8));
    col = mix(col, vec3(0.97, 0.90, 0.80), clamp(foamBand, 0.0, 0.82));

    // Horizon atmospheric blend
    float dist = length(vWorldPos.xz);
    float fog = smoothstep(95.0, 220.0, dist);
    col = mix(col, vec3(0.94, 0.55, 0.32), fog * 0.82);

    gl_FragColor = vec4(col, 1.0);
  }
`;

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
    uEnergy: { value: number };
    uBeat: { value: number };
  };
  private readonly lanternLight: THREE.PointLight;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly baseCameraPos = new THREE.Vector3(0, 1.48, 0.36);
  private readonly baseLookTarget = new THREE.Vector3(0, -1.02, -9.64);
  private pointerX = 0;
  private pointerY = 0;

  constructor(paperCanvas: HTMLCanvasElement, aspect: number) {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x6b3d4a, 0.0032);

    this.camera = new THREE.PerspectiveCamera(58, aspect, 0.05, 450);
    this.camera.position.copy(this.baseCameraPos);
    this.camera.lookAt(this.baseLookTarget);

    const sunDir = new THREE.Vector3(0.14, 0.14, -1.0).normalize();

    // 1. Sunset Sky Dome
    this.skyUniforms = {
      uSunDir: { value: sunDir.clone() },
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uEnergy: { value: 0.2 },
    };
    const skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(280, 48, 32),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERTEX_SHADER,
        fragmentShader: SKY_FRAGMENT_SHADER,
        uniforms: this.skyUniforms,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    this.scene.add(skyDome);

    // 2. Ocean below the mountain cliff
    this.oceanUniforms = {
      uSunDir: { value: sunDir.clone() },
      uCameraPos: { value: this.baseCameraPos.clone() },
      uTime: { value: 0 },
      uEnergy: { value: 0.2 },
      uBeat: { value: 0 },
    };
    const oceanGeo = new THREE.PlaneGeometry(360, 230, 84, 64);
    oceanGeo.rotateX(-Math.PI / 2);
    const ocean = new THREE.Mesh(
      oceanGeo,
      new THREE.ShaderMaterial({
        vertexShader: OCEAN_VERTEX_SHADER,
        fragmentShader: OCEAN_FRAGMENT_SHADER,
        uniforms: this.oceanUniforms,
      }),
    );
    ocean.position.set(0, -14.0, -158);
    this.scene.add(ocean);

    // 3. Curving Golden Sandy Beach Shoreline far below cliff
    this.buildBeachAndHeadlands();

    // 4. High Mountain Cliff Ledge & Foreground Writing Desk
    this.buildCliffEdge();

    // 5. Lighting (Warm sunset directional + twilight sky hemisphere + cozy lantern near paper)
    const hemi = new THREE.HemisphereLight(0xffb885, 0x2c243a, 0.9);
    this.scene.add(hemi);

    this.sunLight = new THREE.DirectionalLight(0xffa65c, 1.55);
    this.sunLight.position.copy(sunDir).multiplyScalar(60);
    this.scene.add(this.sunLight);

    this.lanternLight = new THREE.PointLight(0xffb45a, 1.35, 3.5);
    this.lanternLight.position.set(-0.34, 1.24, -0.42);
    this.scene.add(this.lanternLight);

    // 6. A4 Portrait Sketchbook Paper + Wooden Lapboard in 1st-person foreground
    this.paperTexture = new THREE.CanvasTexture(paperCanvas);
    this.paperTexture.colorSpace = THREE.SRGBColorSpace;
    this.paperTexture.minFilter = THREE.LinearFilter;
    this.paperTexture.magFilter = THREE.LinearFilter;
    this.paperTexture.anisotropy = 4;

    const paperWidth = 0.315;
    const paperHeight = paperWidth * 1.4142; // Exact A4 portrait proportion
    const paperCenter = new THREE.Vector3(0, 1.07, -0.44);
    const paperTiltX = -Math.PI / 2 + 0.62; // Tilted smoothly toward 1st-person view

    // Backing sketchbook board
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(paperWidth + 0.04, paperHeight + 0.036, 0.012),
      new THREE.MeshStandardMaterial({ color: 0x3b2a22, roughness: 0.85, metalness: 0.08 }),
    );
    board.position.copy(paperCenter);
    board.rotation.x = paperTiltX;
    board.translateZ(-0.008);
    this.scene.add(board);

    // Crisp A4 Paper sheet
    this.paperMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(paperWidth, paperHeight, 12, 16),
      new THREE.MeshStandardMaterial({
        map: this.paperTexture,
        roughness: 0.88,
        metalness: 0.0,
      }),
    );
    // Gentle natural paper curvature
    const posAttr = this.paperMesh.geometry.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const px = posAttr.getX(i);
      const py = posAttr.getY(i);
      const curl = Math.pow(Math.abs(px) / (paperWidth * 0.5), 2) * 0.002 + Math.sin((py / paperHeight) * Math.PI) * 0.0015;
      posAttr.setZ(i, curl);
    }
    this.paperMesh.geometry.computeVertexNormals();
    this.paperMesh.position.copy(paperCenter);
    this.paperMesh.rotation.x = paperTiltX;
    this.scene.add(this.paperMesh);

    // Precompute exact world-space basis vectors of the A4 paper for the Magical Flying Pen
    const quat = new THREE.Quaternion().setFromEuler(this.paperMesh.rotation);
    this.paperTransform = {
      center: paperCenter.clone(),
      normal: new THREE.Vector3(0, 0, 1).applyQuaternion(quat).normalize(),
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize(),
      up: new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize(),
      width: paperWidth,
      height: paperHeight,
    };
  }

  private buildBeachAndHeadlands() {
    // Sweeping golden sandy beach crescent clearly visible below the high mountain cliff
    const beachGeo = new THREE.PlaneGeometry(240, 44, 60, 16);
    beachGeo.rotateX(-Math.PI / 2);
    const pos = beachGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const curve = Math.sin(x * 0.045) * 8.0 - (x * x) * 0.0025;
      pos.setZ(i, z + curve);
      // Rise gently inland (+z toward cliff base), dip smoothly under surf at -z
      const slope = (z + 12) * 0.095;
      pos.setY(i, Math.max(-0.5, slope));
    }
    beachGeo.computeVertexNormals();
    const beach = new THREE.Mesh(
      beachGeo,
      new THREE.MeshStandardMaterial({ color: 0xd2ac7e, roughness: 0.92 }),
    );
    beach.position.set(0, -14.1, -54);
    this.scene.add(beach);

    // Coastal mountain headlands flanking left & right in the distance
    const headlandMat = new THREE.MeshStandardMaterial({ color: 0x2e2938, roughness: 0.92 });
    const specs = [
      { x: -46, y: -11, z: -68, rx: 22, ry: 12, rz: 18 },
      { x: 52, y: -10, z: -74, rx: 26, ry: 14, rz: 20 },
      { x: -78, y: -9, z: -106, rx: 32, ry: 17, rz: 26 },
      { x: 84, y: -8, z: -114, rx: 36, ry: 18, rz: 28 },
    ];
    for (const s of specs) {
      const geo = new THREE.ConeGeometry(1, 1, 7);
      const m = new THREE.Mesh(geo, headlandMat);
      m.position.set(s.x, s.y, s.z);
      m.scale.set(s.rx, s.ry, s.rz);
      m.rotation.y = s.x * 0.1;
      this.scene.add(m);
    }
  }

  private buildCliffEdge() {
    // High mountain cliff terrace where the player sits — steep drop reveals the beach below
    const cliffMat = new THREE.MeshStandardMaterial({ color: 0x332b32, roughness: 0.94 });
    const stoneLedge = new THREE.Mesh(new THREE.BoxGeometry(5.5, 16, 2.3), cliffMat);
    stoneLedge.position.set(0, -7.12, -0.15);
    this.scene.add(stoneLedge);

    // Jagged cliff boulders & slope dropping down toward the beach
    const rockGeo = new THREE.DodecahedronGeometry(1, 1);
    const rockSpecs = [
      [-1.7, 0.72, -1.8, 0.9, 0.45, 0.8],
      [1.85, 0.68, -1.9, 1.0, 0.48, 0.85],
      [-2.8, -0.4, -3.6, 1.5, 1.2, 1.4],
      [2.9, -0.6, -3.9, 1.7, 1.3, 1.5],
      [0.0, -3.8, -5.2, 4.8, 3.4, 2.8],
    ];
    for (const [x, y, z, sx, sy, sz] of rockSpecs) {
      const rock = new THREE.Mesh(rockGeo, cliffMat);
      rock.position.set(x, y, z);
      rock.scale.set(sx, sy, sz);
      rock.rotation.set(x * 0.3, z * 0.4, 0.2);
      this.scene.add(rock);
    }

    // Weathered driftwood writing ledge / small cliffside table under the A4 paper
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x4b3426, roughness: 0.88 });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.05, 0.58), woodMat);
    desk.position.set(0, 0.88, -0.45);
    this.scene.add(desk);

    // Cozy warm brass lantern on left edge of ledge
    const lanternBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.042, 0.025, 12),
      new THREE.MeshStandardMaterial({ color: 0x5c4732, metalness: 0.6, roughness: 0.4 }),
    );
    lanternBase.position.set(-0.34, 0.92, -0.42);
    this.scene.add(lanternBase);

    const lanternGlass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.026, 0.026, 0.07, 12),
      new THREE.MeshStandardMaterial({
        color: 0xffd591,
        emissive: 0xff9f3b,
        emissiveIntensity: 1.5,
        roughness: 0.2,
      }),
    );
    lanternGlass.position.set(-0.34, 0.968, -0.42);
    this.scene.add(lanternGlass);

    const lanternCap = new THREE.Mesh(
      new THREE.ConeGeometry(0.04, 0.035, 12),
      new THREE.MeshStandardMaterial({ color: 0x453426, metalness: 0.6, roughness: 0.5 }),
    );
    lanternCap.position.set(-0.34, 1.02, -0.42);
    this.scene.add(lanternCap);

    // Coastal pine silhouettes flanking the cliff edge (left & right peripheral framing)
    const pineMat = new THREE.MeshStandardMaterial({ color: 0x1e2522, roughness: 0.95 });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x30221c, roughness: 0.95 });
    const treePositions = [
      [-2.35, 0.75, -1.9, 1.1],
      [-3.1, 0.3, -3.1, 1.35],
      [2.45, 0.7, -2.1, 1.05],
      [3.2, 0.1, -3.4, 1.4],
    ];
    for (const [x, y, z, scale] of treePositions) {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * scale, 0.08 * scale, 0.9 * scale, 6), trunkMat);
      trunk.position.set(x, y + 0.4 * scale, z);
      this.scene.add(trunk);
      for (let tier = 0; tier < 3; tier++) {
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry((0.46 - tier * 0.1) * scale, 0.65 * scale, 7),
          pineMat,
        );
        cone.position.set(x, y + (0.85 + tier * 0.4) * scale, z);
        this.scene.add(cone);
      }
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

    // Gentle sun descent across the song
    const sunY = 0.16 - frame.progress * 0.095;
    const sunX = -0.18 + frame.progress * 0.36;
    const sunDir = new THREE.Vector3(sunX, sunY, -1.0).normalize();

    this.skyUniforms.uSunDir.value.copy(sunDir);
    this.skyUniforms.uTime.value = elapsedSeconds;
    this.skyUniforms.uProgress.value = frame.progress;
    this.skyUniforms.uEnergy.value = frame.energy;

    this.oceanUniforms.uSunDir.value.copy(sunDir);
    this.oceanUniforms.uTime.value = elapsedSeconds;
    this.oceanUniforms.uEnergy.value = frame.energy;
    this.oceanUniforms.uBeat.value = frame.beat;

    this.sunLight.position.copy(sunDir).multiplyScalar(60);
    this.lanternLight.intensity = 1.25 + Math.sin(elapsedSeconds * 5.2) * 0.08 + frame.beat * 0.25;

    // Subtle 1st-person look parallax that keeps the A4 paper cleanly framed
    const targetLook = this.baseLookTarget.clone();
    targetLook.x += this.pointerX * 0.55;
    targetLook.y += this.pointerY * 0.38;
    this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, this.pointerX * 0.035, 0.08);
    this.camera.position.y = THREE.MathUtils.lerp(
      this.camera.position.y,
      this.baseCameraPos.y + this.pointerY * 0.02 + Math.sin(elapsedSeconds * 0.9) * 0.003,
      0.08,
    );
    this.camera.lookAt(targetLook);
  }
}

