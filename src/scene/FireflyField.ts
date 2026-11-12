import * as THREE from "three";
import type { AssistMode, FireflyCandidate } from "../types";

interface FireflyVisual {
  data: FireflyCandidate;
  root: THREE.Group;
  core: THREE.Mesh;
  coreMat: THREE.MeshBasicMaterial;
  halo: THREE.Sprite;
  haloMat: THREE.SpriteMaterial;
  wingL: THREE.Mesh;
  wingR: THREE.Mesh;
  badge: THREE.Sprite;
  badgeMat: THREE.SpriteMaterial;
  badgeTexture: THREE.CanvasTexture;
  badgeAspect: number;
  currentPos: THREE.Vector3;
  catchStartPos?: THREE.Vector3;
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

function createWordBadgeTexture(
  text: string,
  language: "es" | "en",
  isActiveGlow: boolean,
): { texture: THREE.CanvasTexture; aspect: number } {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const font = '700 44px "Patrick Hand", "Caveat", system-ui, sans-serif';
  ctx.font = font;
  const textWidth = Math.ceil(ctx.measureText(text).width);
  const padX = 28;
  const tagWidth = 38;
  const width = Math.max(150, textWidth + padX * 2 + tagWidth);
  const height = 84;
  c.width = width;
  c.height = height;

  // Pill background
  const r = 24;
  ctx.clearRect(0, 0, width, height);
  ctx.beginPath();
  ctx.roundRect(4, 6, width - 8, height - 12, r);
  ctx.fillStyle = isActiveGlow ? "rgba(42, 26, 20, 0.88)" : "rgba(18, 17, 30, 0.82)";
  ctx.fill();

  ctx.lineWidth = isActiveGlow ? 3.5 : 2.2;
  ctx.strokeStyle = isActiveGlow
    ? "rgba(255, 211, 114, 0.98)"
    : language === "es"
      ? "rgba(246, 178, 91, 0.65)"
      : "rgba(130, 185, 255, 0.65)";
  ctx.stroke();

  // Language chip dot
  ctx.beginPath();
  ctx.roundRect(16, height / 2 - 14, 30, 28, 9);
  ctx.fillStyle = language === "es" ? "rgba(246, 178, 91, 0.28)" : "rgba(116, 180, 255, 0.26)";
  ctx.fill();
  ctx.font = "700 17px system-ui, sans-serif";
  ctx.fillStyle = language === "es" ? "#ffd89b" : "#b5d6ff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(language.toUpperCase(), 31, height / 2 + 1);

  // Word text
  ctx.font = font;
  ctx.fillStyle = isActiveGlow ? "#fff8e6" : "#f7efe0";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 56, height / 2 + 1);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return { texture: tex, aspect: width / height };
}

export class FireflyField {
  private readonly group = new THREE.Group();
  private readonly visuals = new Map<string, FireflyVisual>();
  private readonly glowTex = createGlowTexture();
  private readonly hoverLine: THREE.Line;
  private readonly hoverLinePositions = new Float32Array(6);
  private hoveredId: string | null = null;

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
    this.hoveredId = null;
    this.hoverLine.visible = false;
  }

  getHoveredId(): string | null {
    return this.hoveredId;
  }

  /** Picks the best flying firefly near the given NDC pointer (-1..1). */
  pickAtNdc(ndcX: number, ndcY: number, camera: THREE.PerspectiveCamera): string | null {
    let bestId: string | null = null;
    let bestDist = 0.135; // generous screen-space catch radius (~13.5% half-viewport)
    const proj = new THREE.Vector3();

    for (const v of this.visuals.values()) {
      if (v.data.state !== "flying") continue;
      proj.copy(v.currentPos).project(camera);
      if (proj.z > 1) continue;
      const dx = proj.x - ndcX;
      const dy = proj.y - ndcY;
      // Slightly wider horizontal tolerance for word pills
      const dist = Math.hypot(dx * 0.72, dy * 1.15);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = v.data.id;
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
    // Closest in depth first, then left-to-right
    list.sort((a, b) => b.z - a.z);
    const nearest = list.slice(0, 4);
    nearest.sort((a, b) => a.screenX - b.screenX);
    return nearest.map((item) => item.id);
  }

  update(
    candidates: FireflyCandidate[],
    songTime: number,
    elapsed: number,
    assistMode: AssistMode,
    activeCueId: string | undefined,
    paperDropPos: THREE.Vector3,
    penNibPos: THREE.Vector3,
  ) {
    const activeIds = new Set(candidates.map((c) => c.id));

    // Remove stale visuals
    for (const [id, v] of this.visuals.entries()) {
      if (!activeIds.has(id)) {
        this.disposeVisual(v);
        this.visuals.delete(id);
      }
    }

    // Create or update visuals
    for (const cand of candidates) {
      let v = this.visuals.get(cand.id);
      if (!v) {
        const isActiveHighlight = assistMode === "guided" && cand.isTarget && cand.targetCueId === activeCueId;
        v = this.createVisual(cand, isActiveHighlight);
        this.visuals.set(cand.id, v);
      }

      if (cand.state === "flying") {
        const flightSpan = Math.max(0.5, cand.idealTime - cand.spawnTime);
        const rawT = (songTime - cand.spawnTime) / flightSpan;
        const clamped = Math.max(0, Math.min(1.22, rawT));
        // Ease-out approach so words remain smoothly readable as they enter the catch arc
        const ease = 1 - Math.pow(1 - Math.min(1, clamped), 1.65);
        const overshoot = Math.max(0, clamped - 1);

        const pos = new THREE.Vector3(
          THREE.MathUtils.lerp(cand.originX, cand.catchX, ease),
          THREE.MathUtils.lerp(cand.originY, cand.catchY, ease) + Math.sin(Math.min(1, clamped) * Math.PI) * 0.45,
          THREE.MathUtils.lerp(cand.originZ, cand.catchZ, ease) + overshoot * 2.2,
        );

        // Organic 3D firefly sway across the sky space
        const swayScale = 1 - Math.min(0.7, ease * 0.55);
        pos.x += Math.sin(elapsed * cand.swayFreq + cand.swayPhase) * cand.swayAmpX * swayScale;
        pos.y += Math.cos(elapsed * cand.swayFreq * 1.3 + cand.swayPhase) * cand.swayAmpY * swayScale;

        v.currentPos.copy(pos);
        v.root.position.copy(pos);

        // Wing flutter speeds up as idealTime approaches
        const wingBeat = Math.sin(elapsed * 26 + cand.swayPhase) * 0.65;
        v.wingL.rotation.z = 0.4 + wingBeat;
        v.wingR.rotation.z = -0.4 - wingBeat;

        // Scale word badge gracefully with distance + hover + active cue pulse
        const isHovered = this.hoveredId === cand.id;
        const isActiveTarget = assistMode === "guided" && cand.isTarget && cand.targetCueId === activeCueId;
        const distFactor = THREE.MathUtils.lerp(3.6, 0.42, ease);
        const hoverMult = isHovered ? 1.18 : isActiveTarget ? 1.12 : 1.0;

        v.badge.scale.set(0.24 * v.badgeAspect * distFactor * hoverMult, 0.24 * distFactor * hoverMult, 1);
        v.badge.position.set(0, 0.13 * distFactor, 0);

        const lateFade =
          songTime > cand.idealTime
            ? 1 - Math.min(0.65, (songTime - cand.idealTime) / Math.max(0.3, cand.tooLateTime - cand.idealTime))
            : 1;
        const spawnFade = Math.min(1, Math.max(0, (songTime - cand.spawnTime) / 0.55));
        const alpha = spawnFade * lateFade;

        v.badgeMat.opacity = alpha;
        v.coreMat.opacity = alpha;
        v.haloMat.opacity = alpha * (isHovered || isActiveTarget ? 0.95 : 0.65);

        const haloSize = (isHovered ? 0.52 : isActiveTarget ? 0.44 : 0.32) * (0.65 + ease * 0.55);
        v.halo.scale.set(haloSize, haloSize, 1);

        if (isActiveTarget) {
          v.coreMat.color.setHex(0xffe18c);
          v.haloMat.color.setHex(0xffc95c);
        } else {
          v.coreMat.color.setHex(cand.language === "es" ? 0xffcf7a : 0x99ccff);
          v.haloMat.color.setHex(cand.language === "es" ? 0xffaa44 : 0x70b2ff);
        }
      } else if (cand.state === "caught") {
        if (!v.catchStartPos) v.catchStartPos = v.currentPos.clone();
        const age = Math.max(0, songTime - cand.stateChangedAt);
        const t = Math.min(1, age / 0.36);
        const arc = Math.sin(t * Math.PI) * 0.25;
        v.currentPos.lerpVectors(v.catchStartPos, paperDropPos, t * t);
        v.currentPos.y += arc;
        v.root.position.copy(v.currentPos);
        const s = 1 - t * 0.85;
        v.badge.scale.multiplyScalar(0.92);
        v.core.scale.setScalar(s * 1.4);
        v.badgeMat.opacity = 1 - t;
        v.haloMat.opacity = (1 - t) * 0.95;
        v.coreMat.opacity = 1 - t;
      } else {
        // Missed or dismissed decoy: drift past & dissolve gently
        const age = Math.max(0, songTime - cand.stateChangedAt);
        const t = Math.min(1, age / 0.7);
        v.currentPos.z += 0.025;
        v.currentPos.y += 0.008;
        v.root.position.copy(v.currentPos);
        v.badgeMat.opacity = Math.max(0, (1 - t) * 0.45);
        v.haloMat.opacity = Math.max(0, (1 - t) * 0.3);
        v.coreMat.opacity = Math.max(0, (1 - t) * 0.4);
      }
    }

    // Update subtle golden targeting tether from pen nib to hovered firefly
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

    const coreMat = new THREE.MeshBasicMaterial({
      color: cand.language === "es" ? 0xffcf7a : 0x99ccff,
      transparent: true,
      opacity: 0.95,
    });
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.036, 10, 10), coreMat);
    root.add(core);

    const haloMat = new THREE.SpriteMaterial({
      map: this.glowTex,
      color: cand.language === "es" ? 0xffaa44 : 0x70b2ff,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const halo = new THREE.Sprite(haloMat);
    halo.scale.set(0.32, 0.32, 1);
    root.add(halo);

    const wingGeo = new THREE.PlaneGeometry(0.048, 0.022);
    const wingMat = new THREE.MeshBasicMaterial({
      color: 0xfff3d4,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    });
    const wingL = new THREE.Mesh(wingGeo, wingMat);
    wingL.position.set(-0.032, 0.01, 0);
    const wingR = new THREE.Mesh(wingGeo, wingMat);
    wingR.position.set(0.032, 0.01, 0);
    root.add(wingL, wingR);

    const { texture, aspect } = createWordBadgeTexture(cand.text, cand.language, isActiveGlow);
    const badgeMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
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
      wingL,
      wingR,
      badge,
      badgeMat,
      badgeTexture: texture,
      badgeAspect: aspect,
      currentPos: new THREE.Vector3(cand.originX, cand.originY, cand.originZ),
    };
  }

  private disposeVisual(v: FireflyVisual) {
    this.group.remove(v.root);
    v.core.geometry.dispose();
    v.coreMat.dispose();
    v.haloMat.dispose();
    v.wingL.geometry.dispose();
    (v.wingL.material as THREE.Material).dispose();
    v.badgeTexture.dispose();
    v.badgeMat.dispose();
  }
}

