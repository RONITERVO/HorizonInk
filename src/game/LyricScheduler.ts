import { containsCjk, makeWordKey, normalizeWordKey } from "../lyrics/geminiImport";
import { computeSafeHalfSpreadX, FIREFLY_CATCH_Z, FIREFLY_ORIGIN_Z } from "../scene/fireflyTrajectory";
import type {
  AssistMode,
  FireflyCandidate,
  FireflyLanguageMode,
  GameStats,
  Language,
  PaceMode,
  PrimaryLanguage,
  Segment,
  WordCatchStatus,
  WordCue,
} from "../types";

export const PACE_FLIGHT_SECONDS: Record<PaceMode, number> = {
  relaxed: 4.8,
  standard: 4.0,
  brisk: 3.2,
};

// Cross-song bilingual fallback decoy pools (Spanish + Chinese + English)
const FALLBACK_DECOYS: Record<Language, string[]> = {
  es: [
    "cielo", "noche", "agua", "fuego", "luz", "sombra", "ritmo", "viento",
    "mente", "pulso", "sueño", "arena", "mar", "estrella", "camino", "voz",
    "tierra", "tiempo", "canto", "brisa", "sol", "luna", "latido", "silencio",
    "mirada", "frente", "cerca", "lejos", "siempre", "nunca", "suave", "fuerte",
    "juntos", "libre", "alma", "mundo", "color", "eco", "onda", "espacio",
  ],
  zh: [
    "夜", "风", "雨", "光", "梦", "茶", "山", "水",
    "心", "月", "云", "树", "花", "海", "星", "声",
    "路", "城", "灯", "影", "春", "秋", "雪", "雾",
    "静", "安", "暖", "流", "听", "看", "走", "飞",
    "蓝", "青", "金", "墨", "纸", "诗", "歌", "天",
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

function isPlayableLanguage(language: Language, mode: FireflyLanguageMode): boolean {
  if (mode === "primary") return language !== "en";
  if (mode === "english") return language === "en";
  return true;
}

interface CueHistoryRecord {
  status: "caught" | "missed";
  caughtAt?: number;
  accuracy?: "early" | "perfect" | "late";
}

export interface CatchResult {
  outcome: "caught" | "wrong" | "ignored";
  firefly?: FireflyCandidate;
  cue?: WordCue;
  accuracy?: "early" | "perfect" | "late";
  /** Continuous proximity to the exact vocal moment (0 = far off-beat, 1 = dead-on beat). */
  rhythmResonance?: number;
  flaggedCue?: WordCue;
}

export class LyricScheduler {
  cues: WordCue[] = [];
  fireflies: FireflyCandidate[] = [];
  wordStatuses = new Map<string, WordCatchStatus>();
  wordCaughtAt = new Map<string, number>();
  stats: GameStats = {
    caught: 0,
    perfect: 0,
    missed: 0,
    wrongClicks: 0,
    streak: 0,
    bestStreak: 0,
    totalTargets: 0,
  };

  private paceMode: PaceMode = "standard";
  private flightSeconds = PACE_FLIGHT_SECONDS.standard;
  private languageMode: FireflyLanguageMode = "both";
  private decoyLevel = 0.35;
  private viewportAspect = 16 / 9;
  private lastSegments: Segment[] = [];
  private lastPrimaryLanguageHint?: PrimaryLanguage;
  private lastLaneIndex = -1;
  private cueHistory = new Map<string, CueHistoryRecord>();

  private currentSongWords: Record<Language, Set<string>> = {
    es: new Set(),
    zh: new Set(),
    en: new Set(),
  };
  private crossSongPool: Record<Language, string[]> = {
    es: [...FALLBACK_DECOYS.es],
    zh: [...FALLBACK_DECOYS.zh],
    en: [...FALLBACK_DECOYS.en],
  };
  private decoyPool: Record<Language, string[]> = {
    es: [...FALLBACK_DECOYS.es],
    zh: [...FALLBACK_DECOYS.zh],
    en: [...FALLBACK_DECOYS.en],
  };
  private spawnedCueIndices = new Set<number>();
  private lastDecoySpawnAt = -10;

  setPace(pace: PaceMode) {
    this.paceMode = pace;
    this.flightSeconds = PACE_FLIGHT_SECONDS[pace];
    for (const cue of this.cues) {
      cue.spawnTime = Math.max(0, cue.start - this.flightSeconds);
    }
    for (const ff of this.fireflies) {
      ff.flightSeconds = this.flightSeconds;
      if (ff.isTarget && ff.targetCueId) {
        const cue = this.cues.find((c) => c.id === ff.targetCueId);
        if (cue) ff.spawnTime = cue.spawnTime;
      } else {
        ff.spawnTime = Math.max(0, ff.idealTime - this.flightSeconds);
      }
    }
  }

  setViewportAspect(aspect: number) {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this.viewportAspect = aspect;
    const maxX = computeSafeHalfSpreadX(aspect);
    for (const ff of this.fireflies) {
      ff.catchX = ff.normX * maxX;
      ff.originX = ff.catchX * 6.0;
    }
  }

  getLanguageMode(): FireflyLanguageMode {
    return this.languageMode;
  }

  getDecoyLevel(): number {
    return this.decoyLevel;
  }

  setDecoyLevel(level01: number, currentSeconds?: number) {
    const safe = Number.isFinite(level01) ? Math.max(0, Math.min(1, level01)) : this.decoyLevel;
    this.decoyLevel = safe;
    if (safe <= 0) {
      for (const ff of this.fireflies) {
        if (!ff.isTarget && ff.state === "flying") {
          ff.state = "dismissed";
          ff.stateChangedAt = currentSeconds ?? ff.spawnTime;
        }
      }
    }
  }

  setCrossSongVocabulary(extraEs: string[], extraEn: string[], extraZh: string[] = []) {
    const dedupe = (list: string[], fallback: string[]) => {
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of list) {
        const key = normalizeWordKey(raw);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        cleaned.push(raw);
      }
      if (cleaned.length >= 6) return cleaned;
      for (const raw of fallback) {
        const key = normalizeWordKey(raw);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        cleaned.push(raw);
      }
      return cleaned;
    };
    this.crossSongPool = {
      es: dedupe(extraEs, FALLBACK_DECOYS.es),
      zh: dedupe(extraZh, FALLBACK_DECOYS.zh),
      en: dedupe(extraEn, FALLBACK_DECOYS.en),
    };
    this.rebuildDecoyPool();
  }

  private rebuildDecoyPool() {
    const filterFor = (lang: Language) => {
      const blocked = this.currentSongWords[lang];
      const base = this.crossSongPool[lang];
      const filtered = blocked.size > 0 ? base.filter((w) => !blocked.has(normalizeWordKey(w))) : base;
      return filtered.length >= 6 ? filtered : base;
    };
    this.decoyPool = {
      es: filterFor("es"),
      zh: filterFor("zh"),
      en: filterFor("en"),
    };
  }

  loadSegments(
    segments: Segment[],
    pace: PaceMode,
    primaryLanguageHint?: PrimaryLanguage,
    languageMode: FireflyLanguageMode = this.languageMode,
  ) {
    this.cueHistory.clear();
    this.rebuildSegments(segments, pace, primaryLanguageHint, languageMode, false);
  }

  /** Switches playable firefly language mode mid-song without falsely penalizing skipped past cues. */
  setLanguageMode(mode: FireflyLanguageMode, currentSeconds: number) {
    this.languageMode = mode;
    if (!this.lastSegments.length) return;

    for (const cue of this.cues) {
      if (cue.status === "caught" || cue.status === "missed") {
        this.cueHistory.set(cue.cueKey, {
          status: cue.status,
          caughtAt: cue.caughtAt,
          accuracy: cue.accuracy,
        });
      }
    }

    const prevWrong = this.stats.wrongClicks;
    const prevStreak = this.stats.streak;
    const prevBest = this.stats.bestStreak;
    this.rebuildSegments(this.lastSegments, this.paceMode, this.lastPrimaryLanguageHint, mode, true);

    for (const cue of this.cues) {
      const hist = this.cueHistory.get(cue.cueKey);
      if (hist && (hist.status === "caught" || cue.tooLateTime < currentSeconds)) {
        cue.status = hist.status;
        cue.caughtAt = hist.caughtAt;
        cue.accuracy = hist.accuracy;
        this.wordStatuses.set(cue.cueKey, hist.status);
        if (hist.status === "caught" && hist.caughtAt !== undefined) {
          this.wordCaughtAt.set(cue.cueKey, hist.caughtAt);
        }
      } else if (cue.tooLateTime < currentSeconds) {
        cue.status = "auto";
        this.wordStatuses.set(cue.cueKey, "auto");
      }
    }

    this.lastDecoySpawnAt = currentSeconds - 2;
    this.stats.wrongClicks = prevWrong;
    this.stats.streak = prevStreak;
    this.stats.bestStreak = prevBest;
    this.recomputeStats();
  }

  private rebuildSegments(
    segments: Segment[],
    pace: PaceMode,
    primaryLanguageHint: PrimaryLanguage | undefined,
    languageMode: FireflyLanguageMode,
    preserveHistory: boolean,
  ) {
    this.paceMode = pace;
    this.flightSeconds = PACE_FLIGHT_SECONDS[pace];
    this.languageMode = languageMode;
    this.lastSegments = segments;
    this.lastPrimaryLanguageHint = primaryLanguageHint;
    this.lastLaneIndex = -1;

    this.cues = [];
    this.fireflies = [];
    this.wordStatuses.clear();
    if (!preserveHistory) this.wordCaughtAt.clear();
    this.spawnedCueIndices.clear();
    this.lastDecoySpawnAt = -10;

    // Collect every word chronologically. Native language (es/zh) in a segment always
    // precedes or leads its English echo by timestamp.
    const rawItems: Array<{
      value: string;
      cueKey: string;
      language: Language;
      start: number;
      end: number;
      segment: Segment;
    }> = [];

    for (const seg of segments) {
      const segLang: PrimaryLanguage =
        primaryLanguageHint ??
        (seg.language_code === "zh" || seg.words.some((w) => w.language === "zh" || containsCjk(w.value))
          ? "zh"
          : "es");

      for (const w of seg.words) {
        const lang: Language = w.language ?? (containsCjk(w.value) ? "zh" : segLang);
        rawItems.push({
          value: w.value,
          cueKey: makeWordKey(w),
          language: lang,
          start: w.start,
          end: w.end,
          segment: seg,
        });
      }
      for (const w of seg.translationWords) {
        rawItems.push({
          value: w.value,
          cueKey: makeWordKey(w),
          language: "en",
          start: w.start,
          end: w.end,
          segment: seg,
        });
      }
    }

    rawItems.sort((a, b) => a.start - b.start || (a.language !== "en" ? -1 : 1));

    // Track current song's normalized words so decoys always come from OTHER songs
    this.currentSongWords = {
      es: new Set(
        rawItems
          .filter((i) => i.language === "es")
          .map((i) => normalizeWordKey(i.value))
          .filter(Boolean),
      ),
      zh: new Set(
        rawItems
          .filter((i) => i.language === "zh")
          .map((i) => normalizeWordKey(i.value))
          .filter(Boolean),
      ),
      en: new Set(
        rawItems
          .filter((i) => i.language === "en")
          .map((i) => normalizeWordKey(i.value))
          .filter(Boolean),
      ),
    };
    this.rebuildDecoyPool();

    let cueIdx = 0;
    for (const item of rawItems) {
      if (!isPlayableLanguage(item.language, languageMode)) {
        // Inactive language lines still scribe smoothly on the paper as visual bilingual context
        this.wordStatuses.set(item.cueKey, "auto");
        continue;
      }

      const tooLateTime = Math.max(item.end + 0.45, item.start + 1.05);
      const cue: WordCue = {
        id: `cue-${cueIdx}`,
        cueKey: item.cueKey,
        index: cueIdx,
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
      this.wordStatuses.set(item.cueKey, "pending");
      cueIdx += 1;
    }

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
      if (cue.tooLateTime < seconds) {
        if (cue.status === "pending") {
          cue.status = "missed";
          this.wordStatuses.set(cue.cueKey, "missed");
        }
      } else {
        cue.status = "pending";
        cue.caughtAt = undefined;
        cue.accuracy = undefined;
        this.wordStatuses.set(cue.cueKey, "pending");
        this.wordCaughtAt.delete(cue.cueKey);
        this.cueHistory.delete(cue.cueKey);
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

        if (assistMode !== "zen" && this.decoyLevel > 0) {
          const d = this.decoyLevel;
          const minCooldown = 4.0 * Math.pow(0.06, d);
          const maxTargetsForDecoy = Math.round(6 + d * 4);
          const maxConcurrent = Math.round(9 + d * 11);
          const flyingTargets = this.fireflies.filter((f) => f.state === "flying" && f.isTarget).length;

          if (
            flyingTargets <= maxTargetsForDecoy &&
            seconds - this.lastDecoySpawnAt >= minCooldown &&
            this.activeFlyingCount() < maxConcurrent
          ) {
            this.spawnDecoyNearCue(cue, seconds, 0);
            this.lastDecoySpawnAt = seconds;

            if (
              d >= 0.65 &&
              this.activeFlyingCount() < maxConcurrent &&
              hashFloat(cue.index * 41.3 + seconds * 2.7) < (d - 0.6) / 0.4
            ) {
              this.spawnDecoyNearCue(cue, seconds, 1);
            }
          }
        }
      }
    }

    // 2. Check late / expired targets & zen auto-scribe
    for (const cue of this.cues) {
      if (cue.status !== "pending") continue;

      if (assistMode === "zen" && seconds >= cue.start) {
        cue.status = "auto";
        cue.caughtAt = seconds;
        this.wordStatuses.set(cue.cueKey, "auto");
        this.wordCaughtAt.set(cue.cueKey, seconds);
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
        this.wordStatuses.set(cue.cueKey, "missed");
        this.cueHistory.set(cue.cueKey, { status: "missed" });
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
      // Subtle continuous proximity to exact vocal timing for tactile micro-haptics (no points/judgments)
      const absDelta = Math.abs(delta);
      const rhythmResonance =
        absDelta <= 0.14
          ? 1
          : absDelta >= 0.72
            ? 0
            : Math.max(0, Math.min(1, 1 - (absDelta - 0.14) / (0.72 - 0.14)));

      cue.status = "caught";
      cue.caughtAt = seconds;
      cue.accuracy = accuracy;
      this.wordStatuses.set(cue.cueKey, "caught");
      this.wordCaughtAt.set(cue.cueKey, seconds);
      this.cueHistory.set(cue.cueKey, { status: "caught", caughtAt: seconds, accuracy });

      ff.state = "caught";
      ff.stateChangedAt = seconds;

      this.stats.caught += 1;
      if (accuracy === "perfect") this.stats.perfect += 1;
      this.stats.streak += 1;
      this.stats.bestStreak = Math.max(this.stats.bestStreak, this.stats.streak);

      return { outcome: "caught", firefly: ff, cue, accuracy, rhythmResonance };
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

  /** Returns earliest pending cue at or after `seconds`, useful for instrumental break skip countdowns. */
  getNextUpcomingCue(seconds: number): WordCue | undefined {
    return this.cues.find((c) => c.status === "pending" && c.start > seconds);
  }

  getActiveFireflies(): FireflyCandidate[] {
    return this.fireflies.filter((f) => f.state === "flying");
  }

  private activeFlyingCount(): number {
    return this.fireflies.filter((f) => f.state === "flying").length;
  }

  /**
   * Picks a stratified 2D landing slot right behind the A4 paper, dynamically adapted
   * to the active viewport width and word pill lengths to minimize badge overlap.
   */
  private pickSpacedCatchSlot(
    seedBase: number,
    idealTime: number,
    wordText: string,
    preferSide?: -1 | 1,
  ): {
    catchX: number;
    catchY: number;
    catchZ: number;
    normX: number;
  } {
    const maxX = computeSafeHalfSpreadX(this.viewportAspect);
    const estHalfW = 0.10 + Math.min(12, Math.max(1, wordText.length)) * 0.015;
    const cols = this.viewportAspect < 1.1 ? 5 : 7;
    const rows = this.viewportAspect < 1.1 ? 4 : 3;

    const flyingAll = this.getActiveFireflies();
    const nearby = flyingAll.filter((other) => Math.abs(other.idealTime - idealTime) <= 3.0);
    const compareWith = nearby.length ? nearby : flyingAll;

    let best = {
      catchX: 0,
      catchY: 1.32,
      score: -Infinity,
      col: Math.floor(cols / 2),
    };

    const startCol = Math.floor(hashFloat(seedBase * 1.3) * cols);
    const startRow = Math.floor(hashFloat(seedBase * 2.1) * rows);

    for (let cStep = 0; cStep < cols; cStep += 1) {
      const col = (startCol + cStep) % cols;
      for (let rStep = 0; rStep < rows; rStep += 1) {
        const row = (startRow + rStep) % rows;
        const s = seedBase + col * 13.7 + row * 7.3;

        const baseNormX = cols > 1 ? (col / (cols - 1)) * 2 - 1 : 0;
        const jitterNormX = (hashFloat(s * 1.7) - 0.5) * 0.1;
        const normX = Math.max(-1, Math.min(1, baseNormX + jitterNormX));
        const catchX = normX * maxX;

        const baseFracY = rows > 1 ? row / (rows - 1) : 0.5;
        const jitterY = (hashFloat(s * 6.7) - 0.5) * 0.05;
        const catchY = Math.max(1.18, Math.min(1.46, 1.18 + baseFracY * 0.28 + jitterY));

        let minNormalizedDist = Infinity;
        for (const other of compareWith) {
          const otherHalfW = 0.10 + Math.min(12, Math.max(1, other.text.length)) * 0.015;
          const nx = Math.abs(catchX - other.catchX) / (estHalfW + otherHalfW + 0.04);
          const ny = Math.abs(catchY - other.catchY) / 0.12;
          const d = Math.hypot(nx, ny);
          if (d < minNormalizedDist) minNormalizedDist = d;
        }
        if (compareWith.length === 0) minNormalizedDist = 6;

        let score = minNormalizedDist;
        if (col === this.lastLaneIndex) score -= 0.28;
        if (preferSide !== undefined && Math.sign(catchX || preferSide) === preferSide) {
          score += 0.32;
        }

        if (score > best.score) {
          best = { catchX, catchY, score, col };
        }
      }
    }

    this.lastLaneIndex = best.col;
    const normX = maxX > 0 ? Math.max(-1, Math.min(1, best.catchX / maxX)) : 0;
    return {
      catchX: best.catchX,
      catchY: best.catchY,
      catchZ: FIREFLY_CATCH_Z,
      normX,
    };
  }

  private spawnTargetFirefly(cue: WordCue) {
    const s = cue.index + 1;
    const slot = this.pickSpacedCatchSlot(s * 7.1, cue.idealTime, cue.value);
    const maxX = computeSafeHalfSpreadX(this.viewportAspect);
    const originX = slot.catchX * 6.0;
    const originY = 1.6 + ((slot.catchY - 1.18) / 0.28) * 1.8;

    this.fireflies.push({
      id: `ff-t-${cue.index}`,
      text: cue.value,
      language: cue.language,
      isTarget: true,
      targetCueId: cue.id,
      cueKey: cue.cueKey,
      spawnTime: cue.spawnTime,
      idealTime: cue.idealTime,
      tooLateTime: cue.tooLateTime,
      flightSeconds: this.flightSeconds,
      originX,
      originY,
      originZ: FIREFLY_ORIGIN_Z,
      catchX: slot.catchX,
      catchY: slot.catchY,
      catchZ: FIREFLY_CATCH_Z,
      normX: slot.normX,
      swayFreq: 1.3 + hashFloat(s * 8.1) * 1.2,
      swayPhase: hashFloat(s * 9.3) * Math.PI * 2,
      swayAmpX: Math.min(0.14, maxX * 0.14),
      swayAmpY: 0.06,
      state: "flying",
      stateChangedAt: 0,
    });
  }

  private spawnDecoyNearCue(cue: WordCue, seconds: number, extraIdx = 0) {
    const activeNormalized = new Set(
      this.fireflies.filter((f) => f.state === "flying").map((f) => normalizeWordKey(f.text)),
    );
    // Exclude every word appearing anywhere in the active song or nearby cues
    for (const w of this.currentSongWords[cue.language]) {
      activeNormalized.add(w);
    }
    for (const c of this.cues) {
      if (Math.abs(c.start - cue.start) < 2.4) {
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

    const pickIdx = Math.floor(hashFloat(cue.index * 19.7 + seconds * 3.1 + extraIdx * 43.3) * fallbackPool.length);
    const word = fallbackPool[pickIdx % fallbackPool.length];
    const s = cue.index * 37 + 13 + extraIdx * 53;
    const baseSign: -1 | 1 = hashFloat((cue.index * 37 + 13) * 1.9) > 0.5 ? 1 : -1;
    const sideSign: -1 | 1 = extraIdx % 2 === 1 ? (baseSign === 1 ? -1 : 1) : baseSign;
    const slot = this.pickSpacedCatchSlot(s * 3.3, cue.idealTime, word, sideSign);
    const maxX = computeSafeHalfSpreadX(this.viewportAspect);

    const originX = slot.catchX * 6.0;
    const originY = 1.6 + ((slot.catchY - 1.18) / 0.28) * 1.8;

    this.fireflies.push({
      id: `ff-d-${cue.index}-${extraIdx}-${Math.round(seconds * 100)}`,
      text: word,
      language: cue.language,
      isTarget: false,
      spawnTime: cue.spawnTime,
      idealTime: cue.idealTime,
      tooLateTime: cue.tooLateTime,
      flightSeconds: this.flightSeconds,
      originX,
      originY,
      originZ: FIREFLY_ORIGIN_Z,
      catchX: slot.catchX,
      catchY: slot.catchY,
      catchZ: FIREFLY_CATCH_Z,
      normX: slot.normX,
      swayFreq: 1.4 + hashFloat(s * 9.7) * 1.3,
      swayPhase: hashFloat(s * 10.3) * Math.PI * 2,
      swayAmpX: Math.min(0.14, maxX * 0.14),
      swayAmpY: 0.06,
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
    this.stats.totalTargets = this.cues.length;
  }
}
