import type { AssistMode, MusicLyricWord, Segment, WordCatchStatus } from "../types";
import { displaySegmentAt, wordProgress } from "../lyrics/geminiImport";
import {
  MusicLyricReactivity,
  resolveSketchbookHorizon,
  type MusicLyricBounds,
  type MusicLyricFrame,
} from "./MusicLyricReactivity";

interface RainDrop {
  x: number;
  y: number;
  speed: number;
  length: number;
  depth: number;
  background: boolean;
}

interface Splat {
  x: number;
  y: number;
  age: number;
  duration: number;
  strength: number;
}

interface Bird {
  x: number;
  y: number;
  vx: number;
  vy: number;
  flap: number;
  depth: number;
}

interface Fish {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface PlacedWord extends MusicLyricWord {
  x: number;
  y: number;
  width: number;
  cueId?: string;
}

interface TextLayout {
  words: PlacedWord[];
  font: string;
  size: number;
  height: number;
  top: number;
}

export interface PenPaperTarget {
  u: number;
  v: number;
  isWriting: boolean;
  isTranslation: boolean;
  wordProgress: number;
}

const MAX_DROPS = 420;
const MAX_SPLATS = 96;
const MAX_BIRDS = 5;

function pseudoRandom(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43_758.5453;
  return value - Math.floor(value);
}

function pointInside(x: number, y: number, bounds: MusicLyricBounds): boolean {
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function formatPreciseClock(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
}

export class SketchbookSceneEngine {
  private readonly context: CanvasRenderingContext2D;
  private readonly seeds = Array.from({ length: 256 }, (_, index) => pseudoRandom(index + 7));
  private readonly drops: RainDrop[] = [];
  private readonly splats: Splat[] = [];
  private readonly birds: Bird[] = [];
  private readonly terrainCoordinates = [new Float32Array(144), new Float32Array(144)];
  private scrollX = 0;
  private rainBudget = 0;
  private nextBirdAt = 0;
  private nextFishAt = 0;
  private eventIndex = 0;
  private fish?: Fish;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly logicalWidth: number,
    private readonly logicalHeight: number,
    private readonly pixelRatio: number,
  ) {
    this.canvas.width = Math.round(logicalWidth * pixelRatio);
    this.canvas.height = Math.round(logicalHeight * pixelRatio);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Living sketchbook 2D context unavailable.");
    this.context = context;
  }

  reset() {
    this.drops.length = 0;
    this.splats.length = 0;
    this.birds.length = 0;
    this.fish = undefined;
    this.scrollX = 0;
    this.rainBudget = 0;
    this.nextBirdAt = 0;
    this.nextFishAt = 0;
    this.eventIndex = 0;
  }

  draw(frame: MusicLyricFrame) {
    const ratio = this.pixelRatio;
    const width = this.logicalWidth;
    const height = this.logicalHeight;
    const horizon = resolveSketchbookHorizon(frame.layout.horizon, height);
    const sunX = width * (0.3 + frame.progress * 0.4);
    const sunY = horizon - height * (0.245 + frame.energy * 0.035);
    this.scrollX += frame.delta * (17 + frame.energy * 58 + frame.lowMid * 28);

    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.save();
    context.scale(ratio, ratio);
    this.drawPaper(context, width, height, frame);
    this.drawSky(context, width, horizon, frame);
    this.drawSun(context, width, height, sunX, sunY, frame);
    this.drawTerrain(context, width, height, horizon, frame);
    this.drawWater(context, width, height, horizon, sunX, frame);
    this.drawClouds(context, width, height, sunX, frame);
    this.drawWindNotation(context, width, height, horizon, frame);
    this.processWildlife(context, width, height, horizon, frame);
    this.processWeather(context, width, height, horizon, frame.layout.translation, frame);
    context.restore();
  }

  private drawPaper(context: CanvasRenderingContext2D, width: number, height: number, frame: MusicLyricFrame) {
    context.fillStyle = "#f4eee1";
    context.fillRect(0, 0, width, height);
    context.save();
    context.globalAlpha = 0.045 + frame.air * 0.045;
    context.fillStyle = "#4b423d";
    for (let index = 0; index < 520; index += 1) {
      const seed = this.seeds[index % this.seeds.length];
      const x = (seed * width * 17 + index * 37) % width;
      const y = (seed * height * 23 + index * 61) % height;
      const size = 0.45 + this.seeds[(index + 83) % this.seeds.length] * (0.7 + frame.air);
      context.fillRect(x, y, size, size * 0.55);
    }
    context.restore();
  }

  private drawSky(context: CanvasRenderingContext2D, width: number, horizon: number, frame: MusicLyricFrame) {
    context.save();
    context.globalCompositeOperation = "multiply";
    const gradient = context.createLinearGradient(0, 0, 0, horizon);
    gradient.addColorStop(
      0,
      `hsla(${210 - frame.centroid * 24}, ${15 + frame.presence * 18}%, ${85 - frame.energy * 17}%, ${0.29 + frame.energy * 0.2})`,
    );
    gradient.addColorStop(0.6, `rgba(204, 213, 218, ${0.12 + frame.lowMid * 0.12})`);
    gradient.addColorStop(1, "rgba(240,230,220,.05)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, horizon);
    context.restore();
  }

  private drawSun(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    centerX: number,
    centerY: number,
    frame: MusicLyricFrame,
  ) {
    const smaller = Math.min(width, height);
    const radius = smaller * (0.105 + frame.bass * 0.03 + frame.transient * 0.007 + frame.beat * 0.018);
    const lift = smaller * (0.055 + frame.energy * 0.09);
    context.save();
    context.globalCompositeOperation = "multiply";
    const glow = context.createRadialGradient(centerX, centerY, radius * 0.35, centerX, centerY, radius * 3.4);
    glow.addColorStop(0, `rgba(235,150,45,${0.19 + frame.bass * 0.14 + frame.beat * 0.09})`);
    glow.addColorStop(0.46, `rgba(235,150,45,${0.075 + frame.transient * 0.06 + frame.beat * 0.07})`);
    glow.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = glow;
    context.beginPath();
    context.arc(centerX, centerY, radius * 3.4, 0, Math.PI * 2);
    context.fill();

    context.globalCompositeOperation = "source-over";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "rgba(219,126,26,.68)";
    context.globalAlpha = 0.38 + frame.bass * 0.52;
    for (let ray = 0; ray < 30; ray += 1) {
      const angle = (ray / 30) * Math.PI * 2 + Math.sin(frame.time * 0.6) * 0.03;
      const inner = radius * 1.12 + Math.sin(frame.time * 2 + ray) * 2.5;
      const length = 8 + frame.bass * 34 * this.seeds[ray] + frame.transient * 7 + frame.beat * 25;
      context.lineWidth = 1.1 + frame.bass * 1.8 + frame.beat * 0.9;
      context.beginPath();
      context.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner * 0.9);
      context.lineTo(
        centerX + Math.cos(angle) * (inner + length) + this.jitter(centerX, centerY, 4, frame.time),
        centerY + Math.sin(angle) * (inner + length) * 0.9 + this.jitter(centerY, centerX, 4, frame.time),
      );
      context.stroke();
    }

    for (let pass = 0; pass < 4; pass += 1) {
      context.beginPath();
      for (let point = 0; point <= 156; point += 1) {
        const fraction = point / 156;
        const angle = fraction * Math.PI * 2;
        const band = frame.bands[Math.floor(fraction * (frame.bands.length - 1))] ?? 0;
        const seed = this.seeds[(point + pass * 31) % this.seeds.length];
        const wobble = Math.sin(frame.time * (1.35 + seed) + point * 0.19 + pass) * smaller * 0.0055;
        const rough = Math.sin(point * 0.53 + seed * 9 + frame.time * 0.34) * smaller * 0.0038;
        const lineRadius = radius + band * lift + wobble + rough + pass * smaller * 0.003;
        const x = centerX + Math.cos(angle) * lineRadius;
        const y = centerY + Math.sin(angle) * lineRadius * 0.9;
        if (point === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.strokeStyle = pass === 3 ? "rgba(35,30,28,.72)" : "rgba(219,126,26,.7)";
      context.globalAlpha = pass === 3 ? 0.7 : 0.62 + frame.energy * 0.2;
      context.lineWidth = 0.9 + pass * 0.48 + frame.transient * 0.45 + frame.beat * 0.55;
      context.stroke();
    }
    context.restore();
  }

  private drawTerrain(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    horizon: number,
    frame: MusicLyricFrame,
  ) {
    context.save();
    for (let layer = 0; layer < 2; layer += 1) {
      const points = 72;
      const coordinates = this.terrainCoordinates[layer];
      const parallax = layer === 0 ? 0.24 : 0.56;
      const heightScale = layer === 0 ? 0.105 : 0.155 + frame.lowMid * 0.025;
      context.beginPath();
      context.moveTo(0, horizon);
      for (let index = 0; index < points; index += 1) {
        const x = (index * width) / (points - 1);
        const y = horizon - this.terrainNoise(x + this.scrollX * parallax, layer) * height * heightScale;
        coordinates[index * 2] = x;
        coordinates[index * 2 + 1] = y;
        context.lineTo(x, y);
      }
      context.lineTo(width, horizon);
      context.closePath();
      context.globalCompositeOperation = "source-over";
      context.fillStyle = "#f4eee1";
      context.fill();
      context.globalCompositeOperation = "multiply";
      context.fillStyle =
        layer === 0
          ? `rgba(78,88,91,${0.08 + frame.lowMid * 0.05})`
          : `rgba(62,76,78,${0.15 + frame.lowMid * 0.08})`;
      context.fill();
      context.globalCompositeOperation = "source-over";
      context.strokeStyle = layer === 0 ? "rgba(35,30,28,.24)" : "rgba(35,30,28,.48)";
      context.lineWidth = layer === 0 ? 1 : 1.45;
      context.beginPath();
      for (let index = 0; index < points; index += 1) {
        const baseX = coordinates[index * 2];
        const baseY = coordinates[index * 2 + 1];
        const x = baseX + this.jitter(baseX, baseY, 1.6 + layer, frame.time);
        const y = baseY + this.jitter(baseY, baseX, 1.6 + layer, frame.time);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }
    context.beginPath();
    context.moveTo(0, horizon);
    context.lineTo(width, horizon);
    context.strokeStyle = "rgba(35,30,28,.65)";
    context.lineWidth = 1;
    context.stroke();
    context.restore();
  }

  private drawWater(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    horizon: number,
    sunX: number,
    frame: MusicLyricFrame,
  ) {
    context.save();
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "#f4eee1";
    context.fillRect(0, horizon, width, height - horizon);
    context.globalCompositeOperation = "multiply";
    const wash = context.createLinearGradient(0, horizon, 0, height);
    wash.addColorStop(0, `rgba(110,140,160,${0.19 + frame.lowMid * 0.08})`);
    wash.addColorStop(1, `rgba(78,111,133,${0.25 + frame.energy * 0.09})`);
    context.fillStyle = wash;
    context.fillRect(0, horizon, width, height - horizon);
    context.globalCompositeOperation = "source-over";

    let row = 0;
    for (let y = horizon; y < height; y += 6, row += 1) {
      const depth = (y - horizon) / Math.max(1, height - horizon);
      if (this.seeds[(row * 7 + 19) % this.seeds.length] > 0.83) continue;
      const shift = Math.sin(y * 0.1 + frame.time * 4) * 15 * depth;
      const reflectionWidth =
        width * (0.07 + depth * 0.17 + frame.beat * 0.018) + Math.sin(y * 0.05 + frame.time) * 10;
      const breakup = (this.seeds[(row * 11 + 3) % this.seeds.length] - 0.5) * width * 0.06 * depth;
      context.fillStyle = `rgba(226,143,38,${0.32 * (1 - depth) * (0.5 + frame.energy * 0.58 + frame.beat * 0.22)})`;
      context.fillRect(sunX - reflectionWidth / 2 + shift + breakup, y, reflectionWidth, 1.5 + depth * 2.5);
    }

    const waveCount = 5 + Math.floor(frame.energy * 4 + frame.air * 2);
    context.globalAlpha = 0.24 + frame.air * 0.4 + frame.beat * 0.1;
    context.strokeStyle = "rgba(35,30,28,.72)";
    context.lineWidth = 0.9 + frame.air * 2 + frame.beat * 0.8;
    context.lineCap = "round";
    for (let wave = 0; wave < waveCount; wave += 1) {
      const depth = ((wave + ((frame.time * (0.35 + frame.energy * 0.4)) % 1)) / waveCount);
      if (depth <= 0 || depth >= 1) continue;
      const y = horizon + Math.pow(depth, 1.5) * (height - horizon);
      const waveWidth = width * (0.3 + depth * 0.7);
      const left = (width - waveWidth) / 2;
      context.beginPath();
      for (let point = 0; point < 72; point += 1) {
        const x = left + (waveWidth * point) / 71;
        const sampleIndex =
          Math.floor((point / 72 + depth) * (frame.waveform?.length ?? 72)) % (frame.waveform?.length ?? 72);
        const sample = frame.waveform
          ? ((frame.waveform[sampleIndex] ?? 128) - 128) / 128
          : Math.sin(frame.time * 2 + point * 0.35 + wave) * 0.15;
        const scratch = Math.sin(point * 0.62 + frame.time * 2.4 + wave) * (1 + depth * 3);
        const offset = sample * height * (0.075 + frame.rms * 0.035) * depth + scratch;
        if (point === 0) context.moveTo(x, y + offset);
        else context.lineTo(x, y + offset);
      }
      context.stroke();
    }
    context.restore();
  }

  private drawClouds(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    sunX: number,
    frame: MusicLyricFrame,
  ) {
    context.save();
    context.globalCompositeOperation = "multiply";
    context.filter = `blur(${10 + frame.energy * 7}px)`;
    const segments = 12;
    for (let index = 0; index < segments; index += 1) {
      const value = frame.bands[index * 2] ?? 0;
      if (value < 0.025) continue;
      const centerX = ((index + 0.5) * width) / segments;
      const warmth = Math.max(0, 1 - Math.abs(centerX - sunX) / (width * 0.42));
      const hue = 210 - warmth * 170;
      const lightness = 95 - frame.energy * 47 + warmth * 14;
      context.fillStyle = `hsla(${hue}, ${10 + warmth * 42}%, ${lightness}%, ${value * 0.72})`;
      const centerY = -10 + value * height * 0.15 + Math.sin(frame.time + index) * 10;
      const radius = width * 0.105 + value * width * 0.14;
      context.beginPath();
      for (let point = 0; point <= 14; point += 1) {
        const angle = (point / 14) * Math.PI * 2;
        let shapedRadius = radius * (1 + Math.sin(angle * 3 + frame.time + index) * 0.28);
        if (angle > Math.PI && angle < Math.PI * 2) shapedRadius *= 0.32;
        const x = centerX + Math.cos(angle) * shapedRadius;
        const y = Math.min(centerY + Math.sin(angle) * shapedRadius, centerY + shapedRadius);
        if (point === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.fill();
    }
    context.restore();
  }

  private drawWindNotation(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    horizon: number,
    frame: MusicLyricFrame,
  ) {
    context.save();
    context.strokeStyle = `rgba(24,75,165,${0.04 + frame.air * 0.22})`;
    context.lineWidth = 0.65 + frame.air;
    context.lineCap = "round";
    for (let line = 0; line < 5; line += 1) {
      const seed = this.seeds[170 + line];
      const y = horizon * (0.18 + line * 0.12) + Math.sin(frame.time * 0.4 + line) * 12;
      const travel = ((frame.time * (24 + frame.air * 70) + seed * width) % (width * 1.4)) - width * 0.2;
      const length = width * (0.08 + seed * 0.13);
      context.beginPath();
      context.moveTo(travel, y);
      context.bezierCurveTo(
        travel + length * 0.28,
        y - height * 0.012,
        travel + length * 0.72,
        y + height * 0.012,
        travel + length,
        y,
      );
      context.stroke();
    }
    context.restore();
  }

  private processWildlife(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    horizon: number,
    frame: MusicLyricFrame,
  ) {
    if (frame.time >= this.nextBirdAt && this.birds.length < MAX_BIRDS && (frame.energy > 0.1 || !frame.hasSignal)) {
      const seed = this.nextEventSeed();
      const fromLeft = seed > 0.5;
      this.birds.push({
        x: fromLeft ? -24 : width + 24,
        y: horizon - height * (0.16 + this.nextEventSeed() * 0.27),
        vx: (fromLeft ? 1 : -1) * (85 + this.nextEventSeed() * 95 + frame.energy * 80),
        vy: (this.nextEventSeed() - 0.5) * 28,
        flap: this.nextEventSeed() * Math.PI * 2,
        depth: 0.55 + this.nextEventSeed() * 0.65,
      });
      this.nextBirdAt = frame.time + 5 + this.nextEventSeed() * 8;
    }
    if (!this.fish && frame.time >= this.nextFishAt && (frame.beatTrigger || !frame.hasSignal)) {
      const direction = this.nextEventSeed() > 0.5 ? 1 : -1;
      this.fish = {
        x: width * (0.2 + this.nextEventSeed() * 0.6),
        y: horizon + 4,
        vx: direction * (90 + this.nextEventSeed() * 130),
        vy: -250 - this.nextEventSeed() * 230 - frame.beat * 90,
      };
      this.pushSplat(this.fish.x, horizon, 0.42, 0.9);
      this.nextFishAt = frame.time + 10 + this.nextEventSeed() * 16;
    }

    context.save();
    context.strokeStyle = "rgba(35,30,28,.78)";
    context.lineWidth = 1.35;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (this.fish) {
      this.fish.x += this.fish.vx * frame.delta;
      this.fish.vy += 680 * frame.delta;
      this.fish.y += this.fish.vy * frame.delta;
      if (this.fish.y > horizon + 22 || this.fish.x < -50 || this.fish.x > width + 50) {
        this.pushSplat(this.fish.x, horizon, 0.44, 1);
        this.fish = undefined;
      } else {
        const angle = Math.atan2(this.fish.vy, this.fish.vx);
        context.save();
        context.translate(this.fish.x, this.fish.y);
        context.rotate(angle);
        context.beginPath();
        context.moveTo(-6, 0);
        context.quadraticCurveTo(0, -5, 8, 0);
        context.quadraticCurveTo(0, 5, -6, 0);
        context.moveTo(-6, 0);
        context.lineTo(-11, -4);
        context.moveTo(-6, 0);
        context.lineTo(-11, 4);
        context.stroke();
        context.restore();
      }
    }

    for (let index = this.birds.length - 1; index >= 0; index -= 1) {
      const bird = this.birds[index];
      bird.flap += (12 + frame.presence * 16) * frame.delta;
      if (this.fish && this.fish.y < horizon) {
        bird.vx += (this.fish.x - bird.x) * 0.55 * frame.delta;
        bird.vy += (this.fish.y - bird.y) * 0.55 * frame.delta;
      } else {
        bird.vy += (Math.sin(frame.time + index) * 45 - bird.vy) * frame.delta;
      }
      const speed = Math.hypot(bird.vx, bird.vy);
      if (speed > 320) {
        bird.vx = (bird.vx / speed) * 320;
        bird.vy = (bird.vy / speed) * 320;
      }
      bird.x += bird.vx * frame.delta;
      bird.y += bird.vy * frame.delta;
      if (bird.x < -110 || bird.x > width + 110 || bird.y < -100 || bird.y > horizon + 30) {
        this.birds.splice(index, 1);
        continue;
      }
      const flap = Math.sin(bird.flap) * 6 * bird.depth;
      context.globalAlpha = 0.42 + bird.depth * 0.42;
      context.lineWidth = bird.depth * 1.35;
      context.beginPath();
      context.moveTo(bird.x - 8 * bird.depth, bird.y - flap);
      context.quadraticCurveTo(bird.x - 4, bird.y, bird.x, bird.y + 2);
      context.quadraticCurveTo(bird.x + 4, bird.y, bird.x + 8 * bird.depth, bird.y - flap);
      context.stroke();
    }
    context.restore();
  }

  private processWeather(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    horizon: number,
    translation: MusicLyricBounds | undefined,
    frame: MusicLyricFrame,
  ) {
    const rainIntensity = Math.max(0, frame.energy - 0.24) * 2.2 + frame.transient * 0.32;
    this.rainBudget = Math.min(18, this.rainBudget + rainIntensity * frame.delta * 76);
    while (this.rainBudget >= 1 && this.drops.length < MAX_DROPS) {
      this.rainBudget -= 1;
      const depth = 0.48 + this.nextEventSeed() * 1.45;
      this.drops.push({
        x: this.nextEventSeed() * width,
        y: -24,
        speed: 480 * depth + this.nextEventSeed() * 240 + frame.energy * 330,
        length: 8 * depth + this.nextEventSeed() * 17,
        depth,
        background: this.nextEventSeed() > 0.58,
      });
    }

    context.save();
    context.lineCap = "round";
    context.strokeStyle = "rgba(24,75,165,.38)";
    context.beginPath();
    for (let index = this.drops.length - 1; index >= 0; index -= 1) {
      const drop = this.drops[index];
      drop.y += drop.speed * frame.delta;
      drop.x += drop.speed * (0.025 + frame.air * 0.025) * frame.delta;
      let impactY: number | undefined;
      if (drop.background && drop.y >= horizon) {
        impactY = horizon;
      } else if (!drop.background && translation && pointInside(drop.x, drop.y, translation)) {
        impactY = drop.y;
      } else if (!drop.background && drop.y >= height) {
        impactY = height;
      }
      if (impactY !== undefined) {
        this.pushSplat(drop.x, impactY, 0.22 + drop.depth * 0.08, drop.depth);
        this.drops.splice(index, 1);
        continue;
      }
      context.globalAlpha = drop.background ? 0.16 : 0.28 + drop.depth * 0.15;
      context.lineWidth = drop.background ? 0.7 : 0.8 + drop.depth * 0.55;
      context.moveTo(drop.x, drop.y);
      context.lineTo(drop.x + drop.speed * 0.018, drop.y + drop.length);
    }
    context.stroke();

    for (let index = this.splats.length - 1; index >= 0; index -= 1) {
      const splat = this.splats[index];
      splat.age += frame.delta;
      if (splat.age >= splat.duration) {
        this.splats.splice(index, 1);
        continue;
      }
      const progress = splat.age / splat.duration;
      const radius = progress * (8 + splat.strength * 5);
      context.globalAlpha = (1 - progress) * 0.42;
      context.strokeStyle = "rgba(24,75,165,.82)";
      context.lineWidth = 0.8;
      context.beginPath();
      context.ellipse(splat.x, splat.y, radius * 2, radius * 0.38, 0, 0, Math.PI * 2);
      context.stroke();
      if (splat.strength > 0.9) {
        context.beginPath();
        for (let ray = 0; ray < 5; ray += 1) {
          const angle = (ray / 5) * Math.PI * 2;
          context.moveTo(splat.x + Math.cos(angle) * radius * 0.3, splat.y + Math.sin(angle) * radius * 0.12);
          context.lineTo(splat.x + Math.cos(angle) * radius, splat.y + Math.sin(angle) * radius * 0.38);
        }
        context.stroke();
      }
    }
    context.restore();
  }

  private pushSplat(x: number, y: number, duration: number, strength: number) {
    if (this.splats.length >= MAX_SPLATS) this.splats.shift();
    this.splats.push({ x, y, age: 0, duration, strength });
  }

  private nextEventSeed(): number {
    this.eventIndex = (this.eventIndex + 1) % 1_000_000;
    return pseudoRandom(this.eventIndex * 17 + 311);
  }

  private jitter(x: number, y: number, amount: number, time: number): number {
    const frame = Math.floor(time * 12) % 3;
    const hash = Math.sin(x * 12.9898 + y * 78.233 + frame * 13.131) * 43_758.5453;
    return (hash - Math.floor(hash) - 0.5) * amount;
  }

  private terrainNoise(value: number, layer: number): number {
    const rolling = Math.sin(value * (0.0046 + layer * 0.0005)) * 0.5 + 0.5;
    const detail = Math.sin(value * 0.012 + layer) * 0.25 + Math.sin(value * 0.03 + layer * 2) * 0.125;
    return (rolling + detail) * 0.7 + Math.abs(Math.sin(value * 0.008 + layer)) * 0.3;
  }
}

export class A4PaperVisualizer {
  readonly outputCanvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly sceneCanvas: HTMLCanvasElement;
  private readonly engine: SketchbookSceneEngine;
  private readonly reactivity = new MusicLyricReactivity();
  private readonly frequency = new Uint8Array(512);
  private readonly waveform = new Uint8Array(1024);
  private readonly layoutCache = new Map<Segment, { primary: TextLayout; translation: TextLayout }>();

  // A4 portrait ratio (1 : 1.4142), logical 390 x 552 scaled 2x -> 780 x 1104 crisp canvas
  private readonly logicalWidth = 390;
  private readonly logicalHeight = 552;
  private readonly scale = 2;
  private readonly marginLeft = 34;
  private readonly marginRight = 18;
  private readonly usable = 390 - 34 - 18;
  private readonly center = 34 + (390 - 34 - 18) / 2;

  private title = "Horizon Ink";
  private segments: Segment[] = [];
  private duration = 180;
  private inkLandingFlashes = new Map<string, number>();

  constructor() {
    this.outputCanvas = document.createElement("canvas");
    this.outputCanvas.width = this.logicalWidth * this.scale;
    this.outputCanvas.height = this.logicalHeight * this.scale;
    const ctx = this.outputCanvas.getContext("2d");
    if (!ctx) throw new Error("A4 paper 2D canvas unavailable.");
    this.context = ctx;

    this.sceneCanvas = document.createElement("canvas");
    this.engine = new SketchbookSceneEngine(this.sceneCanvas, this.logicalWidth, this.logicalHeight, this.scale);
  }

  configureSong(title: string, segments: Segment[], duration: number) {
    this.title = title;
    this.segments = segments;
    this.duration = Math.max(1, duration);
    this.layoutCache.clear();
    this.inkLandingFlashes.clear();
    this.reactivity.reset();
    this.engine.reset();
  }

  triggerInkFlash(cueId: string, nowSeconds: number) {
    this.inkLandingFlashes.set(cueId, nowSeconds);
  }

  private buildTextLayout(words: MusicLyricWord[], requestedSize: number, top: number, maxHeight: number): TextLayout {
    let size = requestedSize;
    let lines: PlacedWord[][] = [];
    let font = "";
    const ctx = this.context;

    for (;;) {
      font = `700 ${size}px "Caveat", cursive`;
      ctx.font = font;
      const space = ctx.measureText(" ").width;
      lines = [[]];
      let used = 0;
      let longest = 0;
      for (const word of words) {
        const wordWidth = ctx.measureText(word.value).width;
        longest = Math.max(longest, wordWidth);
        if (used && used + space + wordWidth > this.usable) {
          lines.push([]);
          used = 0;
        }
        if (used) used += space;
        lines[lines.length - 1].push({
          ...word,
          x: used,
          y: 0,
          width: wordWidth,
          cueId: `${word.start.toFixed(2)}:${word.value}`,
        });
        used += wordWidth;
      }
      if (size <= 14 || (lines.length * size * 1.14 <= maxHeight && longest <= this.usable)) break;
      size -= 1;
    }

    const placed: PlacedWord[] = [];
    lines.forEach((line, index) => {
      const extent = line.length ? line[line.length - 1].x + line[line.length - 1].width : 0;
      for (const word of line) {
        placed.push({
          ...word,
          x: this.center - extent / 2 + word.x,
          y: top + index * size * 1.14,
        });
      }
    });

    return {
      words: placed,
      font,
      size,
      height: words.length ? lines.length * size * 1.14 : 0,
      top,
    };
  }

  private getLayout(segment: Segment) {
    const existing = this.layoutCache.get(segment);
    if (existing) return existing;
    const primary = this.buildTextLayout(segment.words, 36, this.logicalHeight * 0.36, this.logicalHeight * 0.21);
    const horizon = resolveSketchbookHorizon(
      primary.words.length ? primary.top + primary.height + 7 : undefined,
      this.logicalHeight,
    );
    const translationTop = horizon + 15;
    const translation = this.buildTextLayout(
      segment.translationWords,
      30,
      translationTop,
      (this.logicalHeight - translationTop - 24) / 0.65,
    );
    const result = { primary, translation };
    this.layoutCache.set(segment, result);
    return result;
  }

  private bounds(layout: TextLayout): MusicLyricBounds | undefined {
    if (!layout.words.length) return undefined;
    return {
      left: Math.min(...layout.words.map((w) => w.x)),
      right: Math.max(...layout.words.map((w) => w.x + w.width)),
      top: layout.top,
      bottom: layout.top + layout.height,
    };
  }

  draw(
    seconds: number,
    analyser: AnalyserNode | undefined,
    wordStatuses: Map<string, WordCatchStatus>,
    assistMode: AssistMode,
    nowMs = performance.now(),
  ): { frame: MusicLyricFrame; penTarget: PenPaperTarget } {
    const segment = displaySegmentAt(this.segments, seconds);
    const layout = segment ? this.getLayout(segment) : undefined;
    const primaryBounds = layout ? this.bounds(layout.primary) : undefined;
    const translationBounds = layout ? this.bounds(layout.translation) : undefined;
    const allWords = layout ? [...layout.primary.words, ...layout.translation.words] : [];
    const active = allWords.find((w) => seconds >= w.start && seconds < w.end);

    const frame = this.reactivity.sample(
      analyser,
      this.frequency,
      this.waveform,
      seconds / this.duration,
      {
        horizon: resolveSketchbookHorizon(primaryBounds ? primaryBounds.bottom + 7 : undefined, this.logicalHeight),
        primary: primaryBounds,
        translation: translationBounds,
        activeWord: active
          ? { left: active.x, right: active.x + active.width, top: active.y, bottom: active.y + 32 }
          : undefined,
      },
      nowMs,
    );

    this.engine.draw(frame);

    const ctx = this.context;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#f4eee1";
    ctx.fillRect(0, 0, this.outputCanvas.width, this.outputCanvas.height);

    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(this.sceneCanvas, 0, 0);
    ctx.globalCompositeOperation = "source-over";

    ctx.save();
    ctx.scale(this.scale, this.scale);

    // Notebook spine shadow, stitched rule & binder holes (exact reference style)
    const spine = 22;
    const shade = ctx.createLinearGradient(0, 0, spine, 0);
    shade.addColorStop(0, "#0005");
    shade.addColorStop(1, "#0000");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, spine, this.logicalHeight);
    ctx.strokeStyle = "#231e1c66";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(spine, 0);
    ctx.lineTo(spine, this.logicalHeight);
    ctx.stroke();
    ctx.setLineDash([]);
    for (let y = 62; y < this.logicalHeight - 20; y += this.logicalHeight / 7) {
      ctx.fillStyle = "#161312";
      ctx.beginPath();
      ctx.arc(spine / 2, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Header title + clock
    ctx.font = '500 19px "Caveat", cursive';
    ctx.textBaseline = "top";
    ctx.globalAlpha = 0.68;
    const clock = formatPreciseClock(seconds);
    const clockWidth = ctx.measureText(clock).width;
    let displayTitle = this.title;
    while (displayTitle.length && ctx.measureText(displayTitle).width > this.usable - clockWidth - 20) {
      displayTitle = displayTitle.slice(0, -1);
    }
    ctx.fillStyle = "#231e1c";
    ctx.fillText(displayTitle + (displayTitle !== this.title ? "…" : ""), this.marginLeft, 28);
    ctx.fillStyle = "#184ba5";
    ctx.fillText(clock, this.logicalWidth - this.marginRight - clockWidth, 28);
    ctx.globalAlpha = 1;

    let penTarget: PenPaperTarget = {
      u: 0.64,
      v: 0.45,
      isWriting: false,
      isTranslation: false,
      wordProgress: 0,
    };

    if (layout && segment) {
      const exit = Math.max(0, Math.min(1, (seconds - segment.end) / 0.42));
      const fade = 1 - exit;

      // Primary (native language, e.g. Spanish) above horizon
      ctx.save();
      ctx.translate(0, -frame.energy * 4.5);
      this.paintWordLayer(ctx, layout.primary, seconds, false, fade, wordStatuses, assistMode, nowMs / 1000);
      ctx.restore();

      // Translation (English) reflected in water below horizon
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, frame.layout.horizon, this.logicalWidth, this.logicalHeight - frame.layout.horizon);
      ctx.clip();
      ctx.translate(this.center, layout.translation.top);
      ctx.transform(1, 0, Math.sin((seconds * Math.PI) / 4) * 0.022, 0.62, 0, Math.sin((seconds * Math.PI) / 4) * 2);
      ctx.translate(-this.center, -layout.translation.top);
      ctx.filter = `blur(${1.7 * this.scale}px)`;
      this.paintWordLayer(
        ctx,
        layout.translation,
        seconds,
        true,
        fade * 0.56,
        wordStatuses,
        assistMode,
        nowMs / 1000,
      );
      ctx.restore();

      // Compute flying pen position on A4 paper
      if (active) {
        const isTrans = layout.translation.words.includes(active);
        const prog = wordProgress(active.start, active.end, seconds);
        const drawX = active.x + active.width * prog;
        const drawY = isTrans
          ? layout.translation.top + (active.y - layout.translation.top) * 0.62 + layout.translation.size * 0.4
          : active.y - frame.energy * 4.5 + layout.primary.size * 0.58;
        penTarget = {
          u: drawX / this.logicalWidth,
          v: drawY / this.logicalHeight,
          isWriting: true,
          isTranslation: isTrans,
          wordProgress: prog,
        };
      } else {
        // Hover poised near the next upcoming word in the segment
        const nextWord = allWords.find((w) => w.start >= seconds);
        if (nextWord) {
          const isTrans = layout.translation.words.includes(nextWord);
          const hoverY = isTrans
            ? layout.translation.top + (nextWord.y - layout.translation.top) * 0.62 + layout.translation.size * 0.4
            : nextWord.y + layout.primary.size * 0.55;
          penTarget = {
            u: nextWord.x / this.logicalWidth,
            v: hoverY / this.logicalHeight,
            isWriting: false,
            isTranslation: isTrans,
            wordProgress: 0,
          };
        }
      }
    }

    ctx.restore();
    return { frame, penTarget };
  }

  private paintWordLayer(
    ctx: CanvasRenderingContext2D,
    layout: TextLayout,
    seconds: number,
    isTranslation: boolean,
    alpha: number,
    wordStatuses: Map<string, WordCatchStatus>,
    assistMode: AssistMode,
    nowSec: number,
  ) {
    ctx.font = layout.font;
    ctx.textBaseline = "top";

    for (const word of layout.words) {
      const cueKey = `${word.start.toFixed(2)}:${word.value}`;
      const status = assistMode === "zen" ? "auto" : (wordStatuses.get(cueKey) ?? "pending");
      const progress = wordProgress(word.start, word.end, seconds);
      const baseColor = isTranslation ? "#184ba5" : "#231e1c";

      // Golden splash glow right when caught firefly touches down on paper
      const flashAt = this.inkLandingFlashes.get(cueKey);
      if (flashAt !== undefined) {
        const age = nowSec - flashAt;
        if (age >= 0 && age < 0.75) {
          ctx.save();
          ctx.globalAlpha = (1 - age / 0.75) * 0.45 * alpha;
          ctx.fillStyle = "#e38f26";
          ctx.beginPath();
          ctx.ellipse(
            word.x + word.width * 0.5,
            word.y + layout.size * 0.55,
            word.width * 0.62 + age * 14,
            layout.size * 0.42 + age * 6,
            0,
            0,
            Math.PI * 2,
          );
          ctx.fill();
          ctx.restore();
        }
      }

      ctx.save();

      if (status === "pending") {
        if (assistMode === "guided") {
          // Subtle pencil baseline slot waiting for the firefly to land (no blur so slot stays crisp)
          ctx.filter = "none";
          ctx.globalAlpha = 0.28 * alpha;
          ctx.strokeStyle = baseColor;
          ctx.lineWidth = 1.1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(word.x, word.y + layout.size * 0.96);
          ctx.lineTo(word.x + word.width, word.y + layout.size * 0.96);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();
        continue;
      }

      if (status === "missed") {
        // Missed word appears lightly penciled with warm amber/rose study underline
        if (progress > 0) {
          ctx.globalAlpha = 0.36 * alpha;
          ctx.fillStyle = baseColor;
          ctx.fillText(word.value, word.x, word.y);
          ctx.strokeStyle = "rgba(196, 77, 86, 0.55)";
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(word.x, word.y + layout.size * 0.96);
          ctx.lineTo(word.x + word.width, word.y + layout.size * 0.96);
          ctx.stroke();
        }
        ctx.restore();
        continue;
      }

      // Caught or Zen auto-scribed: full ink revealed smoothly as pen writes!
      if (progress > 0 || status === "caught") {
        const reveal = status === "caught" && progress === 0 ? 0.16 : progress;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = baseColor;
        if (reveal < 1) {
          const inkPadding = layout.size * 0.22 * reveal;
          ctx.beginPath();
          ctx.rect(
            word.x - layout.size * 0.12,
            word.y - layout.size * 0.2,
            word.width * reveal + layout.size * 0.12 + inkPadding,
            layout.size * 1.6,
          );
          ctx.clip();
        }
        ctx.fillText(word.value, word.x, word.y);
      }

      ctx.restore();
    }
  }
}

