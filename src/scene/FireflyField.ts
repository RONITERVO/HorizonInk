import * as THREE from "three";
import type { AssistMode, FireflyCandidate, Language } from "../types";
import { computeFireflyPosition, FIREFLY_BASE_BADGE_HEIGHT, FIREFLY_CAMERA_Z } from "./fireflyTrajectory";

interface FireflyVisual {
  data: FireflyCandidate;
  root: THREE.Group;
  core: THREE.Mesh;
  coreMat: THREE.MeshBasicMaterial;
  halo: THREE.Sprite;
  haloMat: THREE.SpriteMaterial;
  timingRing: THREE.Mesh;
  timingRingMat: THREE.MeshBasicMaterial;
  wingL: THREE.Mesh;
  wingR: THREE.Mesh;
  wingMat: THREE.MeshBasicMaterial;
  badge: THREE.Sprite;
  badgeMat: THREE.SpriteMaterial;
  badgeTexture: THREE.CanvasTexture;
  badgeAspect: number;
  currentPos: THREE.Vector3;
  catchStartPos?: THREE.Vector3;
  catchStartElapsed?: number;
  catchStartScaleX?: number;
  catchStartScaleY?: number;
  catchDropPos?: THREE.Vector3;
  missStartElapsed?: number;
  badgeHighlighted: boolean;
}

interface BurstSpark {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vel: THREE.Vector3;
  age: number;
  life: number;
}

function createGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  grad.addColorStop(0, "rgba(255, 248, 220, 1)");
  grad.addColorStop(0.25, "rgba(255, 200, 105, 0.85)");
  grad.addColorStop(0.6, "rgba(240, 130, 60, 0.25)");
  grad.addColorStop(1, "rgba(240, 130, 60, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function langColors(language: Language) {
  if (language === "en") {
    return {
      border: "rgba(130, 185, 255, 0.68)",
      chipBg: "rgba(116, 180, 255, 0.26)",
      chipText: "#b5d6ff",
      core: 0x99ccff,
      halo: 0x70b2ff,
    };
  }
  if (language === "zh") {
    return {
      border: "rgba(126, 232, 184, 0.72)",
      chipBg: "rgba(126, 232, 184, 0.26)",
      chipText: "#9df0c6",
      core: 0x9df0c6,
      halo: 0x52d6a0,
    };
  }
  return {
    border: "rgba(246, 178, 91, 0.68)",
    chipBg: "rgba(246, 178, 91, 0.28)",
    chipText: "#ffd89b",
    core: 0xffcf7a,
    halo: 0xffaa44,
  };
}

function paintWordBadgeCanvas(
  canvas: HTMLCanvasElement,
  text: string,
  language: Language,
  isActiveGlow: boolean,
): number {
  const ctx = canvas.getContext("2d")!;
  const font = '700 44px "Patrick Hand", "KaiTi", "STKaiti", "Microsoft YaHei", system-ui, sans-serif';
  ctx.font = font;
  const textWidth = Math.ceil(ctx.measureText(text).width);
  const padX = 28;
  const tagWidth = 38;
  const width = Math.max(150, textWidth + padX * 2 + tagWidth);
  const height = 84;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const colors = langColors(language);
  const r = 24;
  ctx.clearRect(0, 0, width, height);
  ctx.beginPath();
  ctx.roundRect(4, 6, width - 8, height - 12, r);
  ctx.fillStyle = isActiveGlow ? "rgba(42, 24, 16, 0.93)" : "rgba(14, 13, 24, 0.91)";
  ctx.fill();

  ctx.lineWidth = isActiveGlow ? 3.5 : 2.2;
  ctx.strokeStyle = isActiveGlow ? "rgba(255, 211, 114, 0.98)" : colors.border;
  ctx.stroke();

  ctx.beginPath();
  ctx.roundRect(16, height / 2 - 14, 30, 28, 9);
  ctx.fillStyle = colors.chipBg;
  ctx.fill();
  ctx.font = "700 17px system-ui, sans-serif";
  ctx.fillStyle = colors.chipText;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(language.toUpperCase(), 31, height / 2 + 1);

  ctx.font = font;
  ctx.fillStyle = isActiveGlow ? "#fff8e6" : "#f7efe0";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 56, height / 2 + 1);

  return width / height;
}

function createWingGeometry(): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(0.008, 0.009, 0.024, 0.009, 0.032, 0.001);
  shape.bezierCurveTo(0.024, -0.007, 0.009, -0.006, 0, 0);
  return new THREE.ShapeGeometry(shape, 8);
}

export class FireflyField {
  private readonly group = new THREE.Group();
  private readonly visuals = new Map<string, FireflyVisual>();
  private readonly glowTex = createGlowTexture();
  private readonly hoverLine: THREE.Line;
  private readonly hoverLinePositions = new Float32Array(6);
  private readonly burstSparks: BurstSpark[] = [];
  private readonly burstGeo = new THREE.SphereGeometry(0.012, 6, 6);
  private readonly wingGeo = createWingGeometry();
  private readonly ringGeo = new THREE.RingGeometry(0.052, 0.062, 32);
  private hoveredId: string | null = null;
  private lastElapsed = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(this.hoverLinePositions, 3));
    this.hoverLine = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: 0xffd278, transparent: true, opacity: 0.72 }),
    );
    this.hoverLine.visible = false;
    this.hoverLine.frustumCulled = false;
    scene.add(this.hoverLine);
  }

  clear() {
    for (const v of this.visuals.values()) {
      this.disposeVisual(v);
    }
    this.visuals.clear();
    for (const sp of this.burstSparks) {
      this.group.remove(sp.mesh);
      sp.mat.dispose();
    }
    this.burstSparks.length = 0;
    this.hoveredId = null;
    this.hoverLine.visible = false;
  }

  getHoveredId(): string | null {
    return this.hoveredId;
  }

  /** Picks the best flying firefly near the given NDC pointer (-1..1). */
  pickAtNdc(ndcX: number, ndcY: number, camera: THREE.PerspectiveCamera): string | null {
    let bestId: string | null = null;
    let bestScore = Infinity;
    const hitRadius = 0.15;
    const proj = new THREE.Vector3();
    const hitWorld = new THREE.Vector3();

    for (const v of this.visuals.values()) {
      if (v.data.state !== "flying") continue;
      if (FIREFLY_CAMERA_Z - v.currentPos.z < 0.28) continue;
      hitWorld.copy(v.currentPos);
      hitWorld.y += v.badge.position.y * 0.6;
      proj.copy(hitWorld).project(camera);
      if (proj.z > 1) continue;
      const dx = proj.x - ndcX;
      const dy = proj.y - ndcY;
      const dist = Math.hypot(dx * 0.72, dy * 1.12);
      if (dist < hitRadius) {
        // Tie-break slightly toward closer (larger Z) fireflies so foreground words always win
        const score = dist - Math.max(0, (v.currentPos.z + 10) * 0.004);
        if (score < bestScore) {
          bestScore = score;
          bestId = v.data.id;
        }
      }
    }
    this.hoveredId = bestId;
    return bestId;
  }

  /** Returns up to 4 nearest flying fireflies sorted left-to-right for 1-4 hotkey catching. */
  getQuickPickOrder(camera: THREE.PerspectiveCamera): string[] {
    const proj = new THREE.Vector3();
    const list: Array<{ id: string; screenX: number; z: number }> = [];
    for (const v of this.visuals.values()) {
      if (v.data.state !== "flying") continue;
      proj.copy(v.currentPos).project(camera);
      if (proj.z > 1) continue;
      list.push({ id: v.data.id, screenX: proj.x, z: v.currentPos.z });
    }
    list.sort((a, b) => b.z - a.z);
    const nearest = list.slice(0, 4);
    nearest.sort((a, b) => a.screenX - b.screenX);
    return nearest.map((item) => item.id);
  }

  getFireflyScreenPos(fireflyId: string, camera: THREE.PerspectiveCamera): { x: number; y: number } | null {
    const v = this.visuals.get(fireflyId);
    if (!v) return null;
    const proj = v.currentPos.clone().project(camera);
    if (proj.z > 1) return null;
    return {
      x: (proj.x * 0.5 + 0.5) * window.innerWidth,
      y: (-proj.y * 0.5 + 0.5) * window.innerHeight,
    };
  }

  getQuickPickScreenPositions(
    camera: THREE.PerspectiveCamera,
  ): Array<{ id: string; key: number; x: number; y: number }> {
    const order = this.getQuickPickOrder(camera);
    const result: Array<{ id: string; key: number; x: number; y: number }> = [];
    order.forEach((id, idx) => {
      const pos = this.getFireflyScreenPos(id, camera);
      if (pos) result.push({ id, key: idx + 1, x: pos.x, y: pos.y });
    });
    return result;
  }

  spawnCatchBurst(fireflyId: string, isWrong: boolean, language: Language = "es") {
    const v = this.visuals.get(fireflyId);
    if (!v) return;
    const origin = v.currentPos.clone();
    const color = isWrong ? 0xf4a4b2 : language === "en" ? 0x8cc3ff : language === "zh" ? 0x7ee8b8 : 0xffd278;
    const count = isWrong ? 8 : 14;
    for (let i = 0; i < count; i += 1) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
      const mesh = new THREE.Mesh(this.burstGeo, mat);
      mesh.position.copy(origin);
      const theta = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.35) * Math.PI;
      const speed = (isWrong ? 0.55 : 0.95) + Math.random() * 0.85;
      const vel = new THREE.Vector3(
        Math.cos(theta) * Math.cos(phi) * speed,
        Math.sin(phi) * speed * 0.8 + 0.25,
        Math.sin(theta) * Math.cos(phi) * speed,
      );
      this.group.add(mesh);
      this.burstSparks.push({ mesh, mat, vel, age: 0, life: 0.38 + Math.random() * 0.24 });
    }
  }

  update(
    candidates: FireflyCandidate[],
    songTime: number,
    elapsed: number,
    assistMode: AssistMode,
    activeCueId: string | undefined,
    paperDropPos: THREE.Vector3,
    penNibPos: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
    resolveDropPos?: (cueKey?: string) => THREE.Vector3,
  ) {
    const dt = this.lastElapsed > 0 ? Math.min(0.05, Math.max(0.001, elapsed - this.lastElapsed)) : 1 / 60;
    this.lastElapsed = elapsed;
    const activeIds = new Set(candidates.map((c) => c.id));

    for (const [id, v] of this.visuals.entries()) {
      if (!activeIds.has(id)) {
        this.disposeVisual(v);
        this.visuals.delete(id);
      }
    }

    for (const cand of candidates) {
      let v = this.visuals.get(cand.id);
      const isActiveTarget = assistMode === "guided" && cand.isTarget && cand.targetCueId === activeCueId;

      if (!v) {
        v = this.createVisual(cand, isActiveTarget);
        this.visuals.set(cand.id, v);
      } else if (v.badgeHighlighted !== isActiveTarget) {
        v.badgeHighlighted = isActiveTarget;
        const canvas = v.badgeTexture.image as HTMLCanvasElement;
        v.badgeAspect = paintWordBadgeCanvas(canvas, cand.text, cand.language, isActiveTarget);
        v.badgeTexture.needsUpdate = true;
      }

      if (cand.state === "flying") {
        const computed = computeFireflyPosition(cand, songTime, elapsed);
        const depth = computed.depth;
        const safeFlight = Math.max(0.5, cand.flightSeconds || (cand.idealTime - cand.spawnTime));

        v.currentPos.set(computed.x, computed.y, computed.z);
        v.root.position.copy(v.currentPos);
        if (depth.dist <= 0.14) {
          v.root.visible = false;
          continue;
        }
        v.root.visible = true;

        const wingBeat = Math.sin(elapsed * 26 + cand.swayPhase) * 0.65;

        // Keep timing ring facing the camera & contracting onto beat
        v.timingRing.quaternion.copy(camera.quaternion);
        const timeToBeat = cand.idealTime - songTime;
        const approachRatio = Math.max(0, Math.min(1, timeToBeat / safeFlight));
        const ringScale =
          timeToBeat >= 0
            ? 0.9 + approachRatio * 2.2
            : Math.max(0.65, 0.9 - (songTime - cand.idealTime) * 0.25);
        const relScale = depth.badgeWorldHeight / FIREFLY_BASE_BADGE_HEIGHT;
        const bodyScale = 0.62 * (0.65 + relScale * 0.35);

        v.core.scale.setScalar(bodyScale);
        v.wingL.scale.set(-bodyScale, bodyScale, bodyScale);
        v.wingR.scale.set(bodyScale, bodyScale, bodyScale);
        v.wingL.rotation.z = -(0.35 + wingBeat);
        v.wingR.rotation.z = 0.35 + wingBeat;
        v.timingRing.scale.setScalar(ringScale * (depth.badgeWorldHeight / 0.28));

        const isHovered = this.hoveredId === cand.id;
        const hoverMult = isHovered ? 1.18 : isActiveTarget ? 1.12 : 1.0;

        v.badge.renderOrder = depth.renderOrder;
        v.halo.renderOrder = depth.renderOrder - 1;
        v.timingRing.renderOrder = depth.renderOrder - 1;

        v.badge.scale.set(
          depth.badgeWorldHeight * v.badgeAspect * hoverMult,
          depth.badgeWorldHeight * hoverMult,
          1,
        );
        v.badge.position.set(0, depth.badgeWorldHeight * 0.56, 0);

        const lateRatio =
          songTime > cand.idealTime
            ? Math.min(1, (songTime - cand.idealTime) / Math.max(0.3, cand.tooLateTime - cand.idealTime))
            : 0;
        const lateFade = 1 - lateRatio * 0.22;
        const nearCamFade = THREE.MathUtils.smoothstep(depth.dist, 0.14, 0.5);
        const spawnFade = Math.min(1, Math.max(0, (songTime - cand.spawnTime) / 0.35));
        const alpha = spawnFade * lateFade * nearCamFade;

        v.badgeMat.opacity = alpha;
        v.coreMat.opacity = alpha;
        v.wingMat.opacity = alpha * 0.45;
        v.haloMat.opacity = alpha * (isHovered || isActiveTarget ? 0.68 : 0.42);

        const ringPostFade = timeToBeat < 0 ? Math.max(0, 1 - lateRatio * 0.85) : 1;
        const onRhythmPlane = Math.abs(timeToBeat) <= 0.16;
        const ringOpacity =
          (onRhythmPlane || isActiveTarget || isHovered ? 0.68 : 0.25 + (1 - approachRatio) * 0.3) *
          alpha *
          ringPostFade;
        v.timingRingMat.opacity = ringOpacity;
        if (onRhythmPlane) {
          v.timingRingMat.color.setHex(0xffe8a3);
        } else if (isActiveTarget || isHovered) {
          v.timingRingMat.color.setHex(0xffe082);
        } else {
          v.timingRingMat.color.setHex(langColors(cand.language).halo);
        }

        const haloSize = (isHovered ? 0.25 : isActiveTarget ? 0.2 : 0.14) * (0.55 + relScale * 0.45);
        v.halo.scale.set(haloSize, haloSize, 1);

        if (isActiveTarget) {
          v.coreMat.color.setHex(0xffe18c);
          v.haloMat.color.setHex(0xffc95c);
        } else {
          const cols = langColors(cand.language);
          v.coreMat.color.setHex(cols.core);
          v.haloMat.color.setHex(cols.halo);
        }
      } else if (cand.state === "caught") {
        if (!v.catchStartPos) {
          v.catchStartPos = v.currentPos.clone();
          v.catchStartElapsed = elapsed;
          v.catchStartScaleX = v.badge.scale.x;
          v.catchStartScaleY = v.badge.scale.y;
          v.catchDropPos = (resolveDropPos ? resolveDropPos(cand.cueKey) : paperDropPos).clone();
        }
        const dropTarget = resolveDropPos ? resolveDropPos(cand.cueKey) : (v.catchDropPos ?? paperDropPos);
        const catchAge = Math.max(0, elapsed - (v.catchStartElapsed ?? elapsed));
        const t = Math.min(1, catchAge / 0.36);
        const inv = 1 - t;
        // Curved Bezier swoop straight to the word's slot on the A4 sketchbook
        const ctrl = v.catchStartPos
          .clone()
          .lerp(dropTarget, 0.45)
          .add(new THREE.Vector3(0, 0.32, 0.12));
        v.currentPos
          .set(0, 0, 0)
          .addScaledVector(v.catchStartPos, inv * inv)
          .addScaledVector(ctrl, 2 * inv * t)
          .addScaledVector(dropTarget, t * t);
        v.root.position.copy(v.currentPos);
        const s = Math.max(0.05, 1 - t * 0.85);
        v.badge.scale.set(
          (v.catchStartScaleX ?? v.badge.scale.x) * s,
          (v.catchStartScaleY ?? v.badge.scale.y) * s,
          1,
        );
        const wingScale = Math.max(0.001, 1 - t);
        v.wingL.scale.set(-wingScale, wingScale, wingScale);
        v.wingR.scale.set(wingScale, wingScale, wingScale);
        v.core.scale.setScalar((1 - t * 0.88) * 1.45);
        v.timingRingMat.opacity = Math.max(0, (1 - t * 2) * 0.7);
        v.wingMat.opacity = Math.max(0, (1 - t * 1.6) * 0.45);
        v.badgeMat.opacity = 1 - t;
        v.haloMat.opacity = (1 - t) * 0.72;
        v.coreMat.opacity = 1 - t;
        v.root.visible = t < 0.99;
      } else {
        if (v.missStartElapsed === undefined) {
          v.missStartElapsed = elapsed;
        }
        const missAge = Math.max(0, elapsed - v.missStartElapsed);
        const t = Math.min(1, missAge / 0.7);
        v.currentPos.y += 0.16 * dt;
        v.currentPos.z += 0.95 * dt;
        v.root.position.copy(v.currentPos);
        v.timingRingMat.opacity = 0;
        v.wingMat.opacity = Math.max(0, (1 - t) * 0.35);
        v.badgeMat.opacity = Math.max(0, (1 - t) * 0.45);
        v.haloMat.opacity = Math.max(0, (1 - t) * 0.3);
        v.coreMat.opacity = Math.max(0, (1 - t) * 0.4);
        v.root.visible = t < 0.99 && FIREFLY_CAMERA_Z - v.currentPos.z > 0.14;
      }
    }

    // Update 3D burst particles
    for (let i = this.burstSparks.length - 1; i >= 0; i -= 1) {
      const sp = this.burstSparks[i];
      sp.age += dt;
      if (sp.age >= sp.life) {
        this.group.remove(sp.mesh);
        sp.mat.dispose();
        this.burstSparks.splice(i, 1);
        continue;
      }
      sp.mesh.position.addScaledVector(sp.vel, dt);
      sp.vel.y -= dt * 1.25;
      const ratio = 1 - sp.age / sp.life;
      sp.mesh.scale.setScalar(ratio);
      sp.mat.opacity = ratio * 0.95;
    }

    const hoveredVisual = this.hoveredId ? this.visuals.get(this.hoveredId) : undefined;
    if (hoveredVisual && hoveredVisual.data.state === "flying") {
      this.hoverLine.visible = true;
      this.hoverLinePositions[0] = penNibPos.x;
      this.hoverLinePositions[1] = penNibPos.y;
      this.hoverLinePositions[2] = penNibPos.z;
      this.hoverLinePositions[3] = hoveredVisual.currentPos.x;
      this.hoverLinePositions[4] = hoveredVisual.currentPos.y;
      this.hoverLinePositions[5] = hoveredVisual.currentPos.z;
      this.hoverLine.geometry.attributes.position.needsUpdate = true;
    } else {
      this.hoverLine.visible = false;
    }
  }

  private createVisual(cand: FireflyCandidate, isActiveGlow: boolean): FireflyVisual {
    const root = new THREE.Group();
    const cols = langColors(cand.language);

    const coreMat = new THREE.MeshBasicMaterial({
      color: cols.core,
      transparent: true,
      opacity: 0.95,
    });
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.036, 10, 10), coreMat);
    root.add(core);

    const haloMat = new THREE.SpriteMaterial({
      map: this.glowTex,
      color: cols.halo,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const halo = new THREE.Sprite(haloMat);
    halo.scale.set(0.32, 0.32, 1);
    root.add(halo);

    const timingRingMat = new THREE.MeshBasicMaterial({
      color: cols.halo,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const timingRing = new THREE.Mesh(this.ringGeo, timingRingMat);
    root.add(timingRing);

    const wingMat = new THREE.MeshBasicMaterial({
      color: 0xfff3d4,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const wingL = new THREE.Mesh(this.wingGeo, wingMat);
    wingL.position.set(-0.012, 0.008, 0);
    wingL.scale.set(-1, 1, 1);
    const wingR = new THREE.Mesh(this.wingGeo, wingMat);
    wingR.position.set(0.012, 0.008, 0);
    root.add(wingL, wingR);

    const badgeCanvas = document.createElement("canvas");
    const aspect = paintWordBadgeCanvas(badgeCanvas, cand.text, cand.language, isActiveGlow);
    const texture = new THREE.CanvasTexture(badgeCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const badgeMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    const badge = new THREE.Sprite(badgeMat);
    root.add(badge);

    this.group.add(root);
    return {
      data: cand,
      root,
      core,
      coreMat,
      halo,
      haloMat,
      timingRing,
      timingRingMat,
      wingL,
      wingR,
      wingMat,
      badge,
      badgeMat,
      badgeTexture: texture,
      badgeAspect: aspect,
      currentPos: new THREE.Vector3(cand.originX, cand.originY, cand.originZ),
      badgeHighlighted: isActiveGlow,
    };
  }

  private disposeVisual(v: FireflyVisual) {
    this.group.remove(v.root);
    v.core.geometry.dispose();
    v.coreMat.dispose();
    v.haloMat.dispose();
    v.timingRingMat.dispose();
    v.wingMat.dispose();
    v.badgeTexture.dispose();
    v.badgeMat.dispose();
  }
}
