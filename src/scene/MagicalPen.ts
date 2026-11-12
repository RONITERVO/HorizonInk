import * as THREE from "three";
import type { PenPaperTarget } from "../visualizer/SketchbookVisualizer";
import type { SunsetCliffWorld } from "./SunsetCliffWorld";

interface PenSpark {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  age: number;
  life: number;
}

export class MagicalPen {
  readonly group = new THREE.Group();
  readonly nibWorldPos = new THREE.Vector3();

  private readonly barrelMat: THREE.MeshStandardMaterial;
  private readonly glowOrb: THREE.Mesh;
  private readonly glowMat: THREE.MeshBasicMaterial;
  private readonly haloRing: THREE.Mesh;
  private readonly currentTip = new THREE.Vector3(0.05, 1.14, -0.42);
  private readonly sparks: PenSpark[] = [];
  private readonly sparkGroup = new THREE.Group();
  private sparkCooldown = 0;
  private pulseBoost = 0;

  constructor(scene: THREE.Scene) {
    // Pen local origin is at the nib tip (0,0,0), extending up along +Y
    const goldMat = new THREE.MeshStandardMaterial({
      color: 0xe6b450,
      metalness: 0.85,
      roughness: 0.22,
      emissive: 0x5c3605,
      emissiveIntensity: 0.35,
    });
    this.barrelMat = new THREE.MeshStandardMaterial({
      color: 0x1e1824,
      metalness: 0.35,
      roughness: 0.25,
    });

    // Tapered fountain nib
    const nib = new THREE.Mesh(new THREE.ConeGeometry(0.0052, 0.024, 10), goldMat);
    nib.position.y = 0.012;
    nib.rotation.x = Math.PI;
    this.group.add(nib);

    // Collar ring
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.0056, 0.0052, 0.012, 12), goldMat);
    collar.position.y = 0.028;
    this.group.add(collar);

    // Sleek lacquered pen barrel
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.0046, 0.0062, 0.13, 14), this.barrelMat);
    barrel.position.y = 0.098;
    this.group.add(barrel);

    // Tail finial jewel
    const finial = new THREE.Mesh(new THREE.OctahedronGeometry(0.0055, 0), goldMat);
    finial.position.y = 0.168;
    this.group.add(finial);

    // Subtle floating arcane ring around the barrel
    this.haloRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.013, 0.001, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xffc66d, transparent: true, opacity: 0.65 }),
    );
    this.haloRing.position.y = 0.055;
    this.haloRing.rotation.x = Math.PI / 2;
    this.group.add(this.haloRing);

    // Tiny luminous ink droplet at the tip
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xffc257, transparent: true, opacity: 0.9 });
    this.glowOrb = new THREE.Mesh(new THREE.SphereGeometry(0.0038, 10, 10), this.glowMat);
    this.glowOrb.position.y = 0.001;
    this.group.add(this.glowOrb);

    // Natural right-handed fountain pen lean angle over the paper
    this.group.rotation.set(0.28, 0.12, -0.34);

    scene.add(this.group);
    scene.add(this.sparkGroup);
  }

  triggerCatchPulse(isTranslation: boolean) {
    this.pulseBoost = 1.0;
    const color = isTranslation ? 0x70b4ff : 0xffbe55;
    this.glowMat.color.setHex(color);
    for (let i = 0; i < 8; i++) {
      this.spawnSpark(color, 0.45);
    }
  }

  update(dt: number, elapsed: number, target: PenPaperTarget, world: SunsetCliffWorld, beat: number) {
    this.pulseBoost = Math.max(0, this.pulseBoost - dt * 2.2);

    // Hover height: closer to paper when actively writing, lifted slightly when poised/idle
    const lift = target.isWriting ? 0.006 : 0.026 + Math.sin(elapsed * 2.4) * 0.006;
    const desired = world.paperUvToWorld(target.u, target.v, lift);

    if (target.isWriting) {
      // Cursive micro-scribing motion while ink flows onto paper
      desired.x += Math.sin(elapsed * 22) * 0.0025;
      desired.y += Math.cos(elapsed * 18) * 0.0022;
    } else {
      desired.x += Math.sin(elapsed * 1.6) * 0.008;
      desired.y += Math.cos(elapsed * 1.3) * 0.005;
    }

    const followAlpha = 1 - Math.exp(-dt * (target.isWriting ? 24 : 8));
    this.currentTip.lerp(desired, followAlpha);
    this.group.position.copy(this.currentTip);
    this.nibWorldPos.copy(this.currentTip);

    // Subtle expressive pen tilt
    this.group.rotation.z = -0.34 + Math.sin(elapsed * (target.isWriting ? 9 : 2.1)) * (target.isWriting ? 0.06 : 0.025);
    this.group.rotation.x = 0.28 + Math.cos(elapsed * (target.isWriting ? 11 : 1.7)) * 0.03;

    // Arcane halo rotation & glow color
    this.haloRing.rotation.z = elapsed * 1.4;
    const inkHex = target.isTranslation ? 0x6cb2ff : 0xffc057;
    if (this.pulseBoost < 0.1) {
      this.glowMat.color.setHex(inkHex);
    }
    const orbScale = 0.85 + this.pulseBoost * 1.2 + beat * 0.35 + (target.isWriting ? 0.25 : 0);
    this.glowOrb.scale.setScalar(orbScale);
    (this.haloRing.material as THREE.MeshBasicMaterial).opacity =
      0.35 + this.pulseBoost * 0.45 + (target.isWriting ? 0.25 : 0);

    // Emit gentle ink dust sparks while writing
    this.sparkCooldown -= dt;
    if (target.isWriting && this.sparkCooldown <= 0) {
      this.sparkCooldown = 0.055;
      this.spawnSpark(inkHex, 0.14);
    }

    // Update sparks
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt;
      if (s.age >= s.life) {
        this.sparkGroup.remove(s.mesh);
        (s.mesh.material as THREE.Material).dispose();
        s.mesh.geometry.dispose();
        this.sparks.splice(i, 1);
        continue;
      }
      s.mesh.position.addScaledVector(s.vel, dt);
      s.vel.y += dt * 0.08;
      const t = s.age / s.life;
      s.mesh.scale.setScalar(1 - t);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.85;
    }
  }

  private spawnSpark(colorHex: number, speed: number) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.0024, 6, 6),
      new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.9 }),
    );
    mesh.position.copy(this.currentTip);
    const vel = new THREE.Vector3(
      (Math.random() - 0.5) * speed,
      Math.random() * speed * 0.9,
      (Math.random() - 0.5) * speed,
    );
    this.sparkGroup.add(mesh);
    this.sparks.push({ mesh, vel, age: 0, life: 0.45 + Math.random() * 0.25 });
  }
}

