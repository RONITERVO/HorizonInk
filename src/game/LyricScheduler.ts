import { normalizeWordKey } from "../lyrics/geminiImport";
import type {
  AssistMode,
  FireflyCandidate,
  GameStats,
  Language,
  PaceMode,
  Segment,
  WordCatchStatus,
  WordCue,
} from "../types";

export const PACE_FLIGHT_SECONDS: Record<PaceMode, number> = {
  relaxed: 4.8,
  standard: 4.0,
  brisk: 3.2,
};

// Cross-song bilingual fallback decoy pool (Spanish + English) so even short/custom songs
// always have rich, plausible distractors.
const FALLBACK_DECOYS: Record<Language, string[]> = {
  es: [
    "cielo", "noche", "agua", "fuego", "luz", "sombra", "ritmo", "viento",
    "mente", "pulso", "sueño", "arena", "mar", "estrella", "camino", "voz",
    "tierra", "tiempo", "canto", "brisa", "sol", "luna", "latido", "silencio",
    "mirada", "frente", "cerca", "lejos", "siempre", "nunca", "suave", "fuerte",
    "juntos", "libre", "alma", "mundo", "color", "Eco", "onda", "espacio",
  ],
  en: [
    "light", "night", "water", "fire", "sky", "shadow", "rhythm", "wind",
    "mind", "pulse", "dream", "sand", "ocean", "star", "road", "voice",
    "earth", "time", "song", "breeze", "sun", "moon", "heartbeat", "silence",
    "glance", "ahead", "near", "far", "always", "never", "soft", "strong",
    "together", "free", "soul", "world", "color", "echo", "wave", "space",
  ],
};

function hashFloat(seed: number): number {
  const x = Math.sin(seed * 91.3458 + 17.13) * 47453.5453;
  return x - Math.floor(x);
}

export interface CatchResult {
  outcome: "caught" | "wrong" | "ignored";
  firefly?: FireflyCandidate;
  cue?: WordCue;
  accuracy?: "early" | "perfect" | "late";
  flaggedCue?: WordCue;
}

export class LyricScheduler {
  cues: WordCue[] = [];
  fireflies: FireflyCandidate[] = [];
  wordStatuses = new Map<string, WordCatchStatus>();
  stats: GameStats = {
    caught: 0,
    perfect: 0,
    missed: 0,
    wrongClicks: 0,
    streak: 0,
    bestStreak: 0,
    totalTargets: 0,
  };

  private flightSeconds = PACE_FLIGHT_SECONDS.standard;
  private decoyPool: Record<Language, string[]> = {
    es: [...FALLBACK_DECOYS.es],
    en: [...FALLBACK_DECOYS.en],
  };
  private spawnedCueIndices = new Set<number>();
  private lastDecoySpawnAt = -10;
  private maxConcurrentFireflies = 7;

  setPace(pace: PaceMode) {
    this.flightSeconds = PACE_FLIGHT_SECONDS[pace];
    for (const cue of this.cues) {
      cue.spawnTime = Math.max(0, cue.start - this.flightSeconds);
    }
    for (const ff of this.fireflies) {
      if (ff.isTarget && ff.targetCueId) {
        const cue = this.cues.find((c) => c.id === ff.targetCueId);
        if (cue) ff.spawnTime = cue.spawnTime;
      }
    }
  }

  setCrossSongVocabulary(extraEs: string[], extraEn: string[]) {
    this.decoyPool = {
      es: [...new Set([...extraEs, ...FALLBACK_DECOYS.es])],
      en: [...new Set([...extraEn, ...FALLBACK_DECOYS.en])],
    };
  }

  loadSegments(segments: Segment[], pace: PaceMode) {
    this.flightSeconds = PACE_FLIGHT_SECONDS[pace];
    this.cues = [];
    this.fireflies = [];
    this.wordStatuses.clear();
    this.spawnedCueIndices.clear();
    this.lastDecoySpawnAt = -10;

    // Collect every word chronologically. Native language (es) in a segment always precedes
    // or leads its English echo by timestamp.
    const rawItems: Array<{
      value: string;
      language: Language;
      start: number;
      end: number;
      segment: Segment;
    }> = [];

    for (const seg of segments) {
      for (const w of seg.words) {
        rawItems.push({ value: w.value, language: "es", start: w.start, end: w.end, segment: seg });
      }
      for (const w of seg.translationWords) {
        rawItems.push({ value: w.value, language: "en", start: w.start, end: w.end, segment: seg });
      }
    }

    rawItems.sort((a, b) => a.start - b.start || (a.language === "es" ? -1 : 1));

    // Add song's own vocabulary into decoy pools for plausible intra-song distractors
    const songEs = rawItems.filter((i) => i.language === "es").map((i) => i.value.replace(/[.,!?¿¡…]+$/g, ""));
    const songEn = rawItems.filter((i) => i.language === "en").map((i) => i.value.replace(/[.,!?¿¡…]+$/g, ""));
    this.decoyPool = {
      es: [...new Set([...songEs, ...this.decoyPool.es])].filter((w) => normalizeWordKey(w).length > 0),
      en: [...new Set([...songEn, ...this.decoyPool.en])].filter((w) => normalizeWordKey(w).length > 0),
    };

    rawItems.forEach((item, index) => {
      const cueKey = `${item.start.toFixed(2)}:${item.value}`;
      const tooLateTime = Math.max(item.end + 0.45, item.start + 1.05);
      const cue: WordCue = {
        id: `cue-${index}`,
        index,
        value: item.value,
        normalized: normalizeWordKey(item.value),
        language: item.language,
        segmentId: item.segment.id,
        primaryLine: item.segment.primary,
        translationLine: item.segment.translation,
        start: item.start,
        end: item.end,
        spawnTime: Math.max(0, item.start - this.flightSeconds),
        idealTime: item.start,
        tooLateTime,
        status: "pending",
      };
      this.cues.push(cue);
      this.wordStatuses.set(cueKey, "pending");
    });

    this.stats = {
      caught: 0,
      perfect: 0,
      missed: 0,
      wrongClicks: 0,
      streak: 0,
      bestStreak: 0,
      totalTargets: this.cues.length,
    };
  }

  /** Re-sync scheduler when player seeks (e.g., jumping back to practice a missed phrase). */
  syncToTime(seconds: number) {
    this.fireflies = [];
    this.spawnedCueIndices.clear();
    this.lastDecoySpawnAt = seconds - 2;

    for (const cue of this.cues) {
      const cueKey = `${cue.start.toFixed(2)}:${cue.value}`;
      if (cue.tooLateTime < seconds) {
        // Keep previously caught status if already learned, otherwise mark pending/auto
        if (cue.status === "pending") {
          cue.status = "missed";
          this.wordStatuses.set(cueKey, "missed");
        }
      } else {
        // Reset upcoming words so replaying a phrase lets you catch them fresh!
        cue.status = "pending";
        cue.caughtAt = undefined;
        cue.accuracy = undefined;
        this.wordStatuses.set(cueKey, "pending");
      }
    }
    this.recomputeStats();
  }

  update(
    seconds: number,
    assistMode: AssistMode,
  ): { newlyMissed: WordCue[]; newlyAuto: WordCue[] } {
    const newlyMissed: WordCue[] = [];
    const newlyAuto: WordCue[] = [];

    // 1. Spawn approaching target fireflies whose spawnTime has arrived
    for (const cue of this.cues) {
      if (this.spawnedCueIndices.has(cue.index)) continue;
      if (seconds >= cue.spawnTime && seconds <= cue.tooLateTime) {
        this.spawnedCueIndices.add(cue.index);
        this.spawnTargetFirefly(cue);

        // Pair plausible distractor(s) when sky isn't crowded
        if (
          assistMode !== "zen" &&
          seconds - this.lastDecoySpawnAt >= 0.95 &&
          this.activeFlyingCount() < this.maxConcurrentFireflies
        ) {
          this.spawnDecoyNearCue(cue, seconds);
          this.lastDecoySpawnAt = seconds;
        }
      }
    }

    // 2. Check late / expired targets & zen auto-scribe
    for (const cue of this.cues) {
      if (cue.status !== "pending") continue;
      const cueKey = `${cue.start.toFixed(2)}:${cue.value}`;

      if (assistMode === "zen" && seconds >= cue.start) {
        cue.status = "auto";
        this.wordStatuses.set(cueKey, "auto");
        const ff = this.fireflies.find((f) => f.targetCueId === cue.id && f.state === "flying");
        if (ff) {
          ff.state = "caught";
          ff.stateChangedAt = seconds;
        }
        newlyAuto.push(cue);
        continue;
      }

      if (seconds > cue.tooLateTime) {
        cue.status = "missed";
        this.wordStatuses.set(cueKey, "missed");
        this.stats.streak = 0;
        this.stats.missed += 1;
        const ff = this.fireflies.find((f) => f.targetCueId === cue.id && f.state === "flying");
        if (ff) {
          ff.state = "missed";
          ff.stateChangedAt = seconds;
        }
        newlyMissed.push(cue);
      }
    }

    // 3. Expire decoys & cull finished fireflies
    this.fireflies = this.fireflies.filter((ff) => {
      if (ff.state === "flying" && !ff.isTarget && seconds > ff.tooLateTime) {
        ff.state = "missed";
        ff.stateChangedAt = seconds;
      }
      if (ff.state === "flying") return true;
      return seconds - ff.stateChangedAt < 1.1;
    });

    return { newlyMissed, newlyAuto };
  }

  catchFirefly(fireflyId: string, seconds: number): CatchResult {
    const ff = this.fireflies.find((f) => f.id === fireflyId && f.state === "flying");
    if (!ff) return { outcome: "ignored" };

    if (ff.isTarget && ff.targetCueId) {
      const cue = this.cues.find((c) => c.id === ff.targetCueId);
      if (!cue || cue.status !== "pending") {
        ff.state = "dismissed";
        ff.stateChangedAt = seconds;
        return { outcome: "ignored" };
      }

      const delta = seconds - cue.idealTime;
      const accuracy: "early" | "perfect" | "late" =
        Math.abs(delta) <= 0.42 ? "perfect" : delta < 0 ? "early" : "late";

      cue.status = "caught";
      cue.caughtAt = seconds;
      cue.accuracy = accuracy;
      this.wordStatuses.set(`${cue.start.toFixed(2)}:${cue.value}`, "caught");

      ff.state = "caught";
      ff.stateChangedAt = seconds;

      this.stats.caught += 1;
      if (accuracy === "perfect") this.stats.perfect += 1;
      this.stats.streak += 1;
      this.stats.bestStreak = Math.max(this.stats.bestStreak, this.stats.streak);

      return { outcome: "caught", firefly: ff, cue, accuracy };
    }

    // Caught a plausible decoy -> no fail/game-over! Flag the nearest active target for review.
    ff.state = "dismissed";
    ff.stateChangedAt = seconds;
    this.stats.wrongClicks += 1;
    this.stats.streak = 0;

    const nearestCue = this.getActiveCue(seconds);
    return {
      outcome: "wrong",
      firefly: ff,
      flaggedCue: nearestCue,
    };
  }

  /** Returns currently active target cue (nearest in idealTime within flying window). */
  getActiveCue(seconds: number): WordCue | undefined {
    const flyingTargets = this.cues.filter(
      (c) => c.status === "pending" && seconds >= c.spawnTime && seconds <= c.tooLateTime,
    );
    if (!flyingTargets.length) return undefined;
    flyingTargets.sort((a, b) => Math.abs(a.idealTime - seconds) - Math.abs(b.idealTime - seconds));
    return flyingTargets[0];
  }

  getActiveFireflies(): FireflyCandidate[] {
    return this.fireflies.filter((f) => f.state === "flying");
  }

  private activeFlyingCount(): number {
    return this.fireflies.filter((f) => f.state === "flying").length;
  }

  private spawnTargetFirefly(cue: WordCue) {
    const s = cue.index + 1;
    // Spread naturally across the whole 3D space from the sunset horizon (z=-42..-35)
    // to a spacious 3D catch-arc in front of the player (not flat on a plane!)
    const laneAngle = (hashFloat(s * 1.7) - 0.5) * 1.15;
    const originX = Math.sin(laneAngle) * (9 + hashFloat(s * 2.3) * 8);
    const originY = 2.4 + hashFloat(s * 3.1) * 5.2;
    const originZ = -42 + hashFloat(s * 4.7) * 6;

    const catchX = Math.sin(laneAngle) * (1.25 + hashFloat(s * 5.9) * 0.75);
    const catchY = 1.18 + hashFloat(s * 6.7) * 1.18;
    const catchZ = -2.45 + hashFloat(s * 7.3) * 0.95;

    this.fireflies.push({
      id: `ff-t-${cue.index}`,
      text: cue.value,
      language: cue.language,
      isTarget: true,
      targetCueId: cue.id,
      spawnTime: cue.spawnTime,
      idealTime: cue.idealTime,
      tooLateTime: cue.tooLateTime,
      originX,
      originY,
      originZ,
      catchX,
      catchY,
      catchZ,
      swayFreq: 1.3 + hashFloat(s * 8.1) * 1.2,
      swayPhase: hashFloat(s * 9.3) * Math.PI * 2,
      swayAmpX: 0.22 + hashFloat(s * 10.7) * 0.25,
      swayAmpY: 0.14 + hashFloat(s * 11.9) * 0.18,
      state: "flying",
      stateChangedAt: 0,
    });
  }

  private spawnDecoyNearCue(cue: WordCue, seconds: number) {
    const activeNormalized = new Set(
      this.fireflies.filter((f) => f.state === "flying").map((f) => normalizeWordKey(f.text)),
    );
    // Also avoid words appearing within +-2s so decoys are never accidentally the next word!
    for (const c of this.cues) {
      if (Math.abs(c.start - cue.start) < 2.2) {
        activeNormalized.add(c.normalized);
      }
    }

    const pool = this.decoyPool[cue.language];
    const targetLen = cue.normalized.length;
    const candidates = pool.filter((w) => {
      const n = normalizeWordKey(w);
      return n.length > 0 && !activeNormalized.has(n) && Math.abs(n.length - targetLen) <= 4;
    });
    const fallbackPool = candidates.length ? candidates : pool.filter((w) => !activeNormalized.has(normalizeWordKey(w)));
    if (!fallbackPool.length) return;

    const pickIdx = Math.floor(hashFloat(cue.index * 19.7 + seconds * 3.1) * fallbackPool.length);
    const word = fallbackPool[pickIdx % fallbackPool.length];
    const s = cue.index * 37 + 13;
    const sideSign = hashFloat(s * 1.9) > 0.5 ? 1 : -1;

    const originX = sideSign * (4 + hashFloat(s * 2.7) * 11);
    const originY = 2.6 + hashFloat(s * 3.5) * 5.6;
    const originZ = -43 + hashFloat(s * 4.1) * 6;

    const catchX = sideSign * (0.65 + hashFloat(s * 5.3) * 1.45);
    const catchY = 1.22 + hashFloat(s * 6.1) * 1.15;
    const catchZ = -2.6 + hashFloat(s * 7.7) * 1.0;

    this.fireflies.push({
      id: `ff-d-${cue.index}-${Math.round(seconds * 100)}`,
      text: word,
      language: cue.language,
      isTarget: false,
      spawnTime: cue.spawnTime + 0.15,
      idealTime: cue.idealTime + (hashFloat(s * 8.9) - 0.5) * 0.35,
      tooLateTime: cue.tooLateTime + 0.25,
      originX,
      originY,
      originZ,
      catchX,
      catchY,
      catchZ,
      swayFreq: 1.4 + hashFloat(s * 9.7) * 1.3,
      swayPhase: hashFloat(s * 10.3) * Math.PI * 2,
      swayAmpX: 0.28 + hashFloat(s * 11.1) * 0.25,
      swayAmpY: 0.16 + hashFloat(s * 12.3) * 0.2,
      state: "flying",
      stateChangedAt: 0,
    });
  }

  private recomputeStats() {
    let caught = 0;
    let perfect = 0;
    let missed = 0;
    for (const c of this.cues) {
      if (c.status === "caught") {
        caught += 1;
        if (c.accuracy === "perfect") perfect += 1;
      } else if (c.status === "missed") {
        missed += 1;
      }
    }
    this.stats.caught = caught;
    this.stats.perfect = perfect;
    this.stats.missed = missed;
  }
}

