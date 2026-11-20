import * as THREE from "three";
import "./style.css";
import { SongAudioEngine } from "./audio/SongAudioEngine";
import { LyricScheduler, PACE_FLIGHT_SECONDS } from "./game/LyricScheduler";
import { SongProgressStore, StudyDeck } from "./game/StudyDeck";
import {
  convertGeminiJson,
  displaySegmentAt,
  extractOtherSongVocabulary,
  makeWordKey,
} from "./lyrics/geminiImport";
import { FireflyField } from "./scene/FireflyField";
import { MagicalPen } from "./scene/MagicalPen";
import { SunsetCliffWorld } from "./scene/SunsetCliffWorld";
import type {
  AssistMode,
  FireflyLanguageMode,
  PaceMode,
  PrimaryLanguage,
  Segment,
  SongManifestEntry,
} from "./types";
import { A4PaperVisualizer } from "./visualizer/SketchbookVisualizer";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LANG_MODE_STORAGE_KEY = "horizon-ink-lang-mode-v1";
const DECOY_LEVEL_STORAGE_KEY = "horizon-ink-decoy-level-v1";
const PACE_MODE_STORAGE_KEY = "horizon-ink-pace-mode-v1";
const ASSIST_MODE_STORAGE_KEY = "horizon-ink-assist-mode-v1";
const VOLUME_STORAGE_KEY = "horizon-ink-volume-v1";

function loadSavedEnum<T extends string>(key: string, valid: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key) as T | null;
    if (raw && valid.includes(raw)) return raw;
  } catch {
    // ignore
  }
  return fallback;
}

function loadSavedClampedInt(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const num = Number(raw);
      if (Number.isFinite(num)) return Math.max(0, Math.min(100, Math.round(num)));
    }
  } catch {
    // ignore
  }
  return fallback;
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SPEED_STEPS = [1.0, 0.85, 0.75];

class HorizonInkApp {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly paperViz = new A4PaperVisualizer();
  private readonly world: SunsetCliffWorld;
  private readonly pen: MagicalPen;
  private readonly fireflies: FireflyField;
  private readonly audio = new SongAudioEngine();
  private readonly scheduler = new LyricScheduler();
  private readonly studyDeck = new StudyDeck();
  private readonly progressStore = new SongProgressStore();

  private manifest: SongManifestEntry[] = [];
  private activeFilter: "all" | "es" | "zh" | "review" = "all";
  private searchQuery = "";
  private activeSongId = "";
  private activeSongTitle = "Horizon Ink";
  private activePrimaryLang: PrimaryLanguage = "es";
  private activeSegments: Segment[] = [];
  private paceMode: PaceMode = loadSavedEnum(PACE_MODE_STORAGE_KEY, ["relaxed", "standard", "brisk"], "standard");
  private assistMode: AssistMode = loadSavedEnum(ASSIST_MODE_STORAGE_KEY, ["guided", "immersion", "zen"], "guided");
  private languageMode: FireflyLanguageMode = loadSavedEnum(
    LANG_MODE_STORAGE_KEY,
    ["both", "primary", "english"],
    "both",
  );
  private decoyPercent = loadSavedClampedInt(DECOY_LEVEL_STORAGE_KEY, 35);
  private volumePercent = loadSavedClampedInt(VOLUME_STORAGE_KEY, 100);
  private speedIndex = 0;

  private customAudioFile: File | null = null;
  private customTimingText: string | null = null;

  private isPlayingSession = false;
  private isScrubbing = false;
  private isPointerDown = false;
  private pointerNdc = new THREE.Vector2(0, 0);
  private swipePoints: Array<{ x: number; y: number; at: number }> = [];
  private flaggedInCurrentSong = new Set<string>();
  private showKeycapHints = false;
  private toastTimeout: number | undefined;
  private lastTimeMs = performance.now();
  private elapsedSeconds = 0;

  constructor() {
    const canvas = $<HTMLCanvasElement>("scene-canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.96;

    this.world = new SunsetCliffWorld(this.paperViz.outputCanvas, window.innerWidth / window.innerHeight);
    this.pen = new MagicalPen(this.world.scene);
    this.fireflies = new FireflyField(this.world.scene);
    this.scheduler.setViewportAspect(window.innerWidth / Math.max(1, window.innerHeight));
    this.syncLangModeControls();
    this.applyPaceMode(this.paceMode, false);
    this.applyAssistMode(this.assistMode, false);
    this.applyDecoyPercent(this.decoyPercent, false);
    this.applyVolumePercent(this.volumePercent);

    this.bindEvents();
    this.audio.onEnded(() => {
      if (this.activeSongId && !this.activeSongId.startsWith("custom:")) {
        const s = this.scheduler.stats;
        const pct = s.totalTargets > 0 ? (s.caught / s.totalTargets) * 100 : 0;
        this.progressStore.recordSession(this.activeSongId, pct, s.bestStreak);
        this.renderSongGrid();
      }
      this.openStudyModal(true);
    });
  }

  async init() {
    await Promise.allSettled([
      document.fonts.load('700 42px "Caveat"'),
      document.fonts.load('700 40px "Patrick Hand"'),
      document.fonts.ready,
    ]);

    try {
      const resp = await fetch("./songs-manifest.json");
      if (resp.ok) {
        this.manifest = (await resp.json()) as SongManifestEntry[];
      }
    } catch {
      this.manifest = [];
    }

    this.seedOtherSongVocabulary();
    this.renderSongGrid();
    this.updateDeckBadges();

    if (this.manifest.length > 0) {
      this.paperViz.configureSong(this.manifest[0].title, [], this.manifest[0].duration);
    }

    requestAnimationFrame((t) => this.loop(t));
  }

  /** Seeds decoy pools strictly from OTHER songs in the library (excluding the active song and identical-lyric siblings). */
  private seedOtherSongVocabulary(activeSongId?: string) {
    const vocab = extractOtherSongVocabulary(this.manifest, activeSongId);
    this.scheduler.setCrossSongVocabulary(vocab.es, vocab.en, vocab.zh);
  }

  private getFilteredManifest(): SongManifestEntry[] {
    const q = this.searchQuery.trim().toLowerCase();
    const reviewIds = this.studyDeck.songIdsWithItems();
    return this.manifest.filter((item) => {
      if (this.activeFilter === "es" && item.primaryLanguage !== "es") return false;
      if (this.activeFilter === "zh" && item.primaryLanguage !== "zh") return false;
      if (this.activeFilter === "review" && !reviewIds.has(item.id)) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.genre.toLowerCase().includes(q)
      );
    });
  }

  private renderSongGrid() {
    const grid = $("song-grid");
    grid.replaceChildren();
    const filtered = this.getFilteredManifest();
    $("song-count-label").textContent = `${filtered.length} of ${this.manifest.length} tracks`;

    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "subtitle";
      empty.textContent = "No matching tracks. Try another filter or clear your search.";
      grid.appendChild(empty);
      return;
    }

    for (const item of filtered) {
      const prog = this.progressStore.get(item.id);
      const reviewCnt = this.studyDeck.count(item.id);
      const card = document.createElement("button");
      card.className = "song-card";
      card.innerHTML = `
        <div>
          <div class="song-card-top">
            <div class="song-card-title">${escapeHtml(item.title)}</div>
            <div class="song-card-tags">
              ${prog ? `<span class="best-pill">${prog.bestAccuracy}%</span>` : ""}
              <span class="lang-pill ${item.primaryLanguage === "zh" ? "zh" : ""}">${item.primaryLanguage.toUpperCase()}</span>
            </div>
          </div>
          <div class="song-card-sub">${escapeHtml(item.subtitle)}</div>
        </div>
        <div class="song-card-meta">
          <span>${formatClock(item.duration)} · ${escapeHtml(item.genre)}</span>
          <span>${item.wordCount} words${reviewCnt ? ` · ${reviewCnt} review` : ""}</span>
        </div>
      `;
      card.addEventListener("click", () => void this.startManifestSong(item));
      grid.appendChild(card);
    }
  }

  private async startManifestSong(item: SongManifestEntry, seekAfterLoad?: number) {
    this.showToast(`Loading ${item.title}…`, "good");
    const res = await fetch(item.timingUrl);
    if (!res.ok) {
      this.showToast("Failed to load timing JSON.", "miss");
      return;
    }
    const text = await res.text();
    const converted = convertGeminiJson(text, {
      title: item.title,
      lyrics: item.lyricsText,
      primaryLanguage: item.primaryLanguage,
    });
    const duration = await this.audio.loadUrl(item.audioUrl);

    await this.beginSongSession(
      item.id,
      item.title,
      converted.primaryLanguage,
      converted.segments,
      duration,
      seekAfterLoad,
    );
  }

  private async startCustomSong() {
    if (!this.customAudioFile || !this.customTimingText) return;
    try {
      const title = this.customAudioFile.name.replace(/\.[^.]+$/, "");
      const converted = convertGeminiJson(this.customTimingText, { title });
      const duration = await this.audio.loadFile(this.customAudioFile);
      await this.beginSongSession(
        `custom:${title}`,
        converted.title,
        converted.primaryLanguage,
        converted.segments,
        duration,
      );
    } catch (err) {
      $("custom-status").textContent = (err as Error).message;
    }
  }

  private async beginSongSession(
    id: string,
    title: string,
    primaryLanguage: PrimaryLanguage,
    segments: Segment[],
    duration: number,
    seekTo?: number,
  ) {
    this.activeSongId = id;
    this.activeSongTitle = title;
    this.activePrimaryLang = primaryLanguage;
    this.activeSegments = segments;

    this.flaggedInCurrentSong.clear();
    this.fireflies.clear();
    this.seedOtherSongVocabulary(id);
    this.scheduler.setViewportAspect(window.innerWidth / Math.max(1, window.innerHeight));
    this.scheduler.loadSegments(segments, this.paceMode, primaryLanguage, this.languageMode);
    this.paperViz.configureSong(title, segments, duration);
    this.syncLangModeControls();

    if (seekTo !== undefined && seekTo > 0) {
      this.seekSessionTo(seekTo);
    }

    $<HTMLSpanElement>("hud-song-title").textContent = title;
    const slider = $<HTMLInputElement>("seek-slider");
    slider.max = String(Math.max(1, duration));
    slider.value = String(seekTo ?? 0);
    $("hud-clock").textContent = `${formatClock(seekTo ?? 0)} / ${formatClock(duration)}`;

    $("overlay-menu").classList.add("hidden");
    $("overlay-study").classList.add("hidden");
    $("hud").classList.remove("hidden");
    $("cue-hint").classList.remove("hidden");

    this.isPlayingSession = true;
    this.updateStatsHud();
    await this.audio.play();
    $("btn-play-pause").textContent = "❚❚";
    this.showToast("Catch incoming words as they approach from the horizon", "good");
  }

  private seekSessionTo(seconds: number) {
    this.flaggedInCurrentSong.clear();
    this.audio.seek(seconds);
    this.scheduler.syncToTime(seconds);
    this.paperViz.syncToTime();
    this.fireflies.clear();
    this.updateStatsHud();
  }

  private skipToNextLyric() {
    if (!this.isPlayingSession) return;
    const now = this.audio.currentTime;
    const nextCue = this.scheduler.getNextUpcomingCue(now);
    if (!nextCue) return;
    const leadWindow = Math.max(3.6, PACE_FLIGHT_SECONDS[this.paceMode]);
    const target = Math.max(now, nextCue.start - leadWindow);
    if (target <= now + 0.5) return;
    this.seekSessionTo(target);
    this.showToast("Jumped to next verse", "good");
  }

  private playNextSongInManifest() {
    if (!this.manifest.length) return;
    const idx = this.manifest.findIndex((s) => s.id === this.activeSongId);
    const next = this.manifest[(idx + 1) % this.manifest.length];
    void this.startManifestSong(next);
  }

  private bindEvents() {
    window.addEventListener("resize", () => {
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.world.resize(window.innerWidth, window.innerHeight);
      this.scheduler.setViewportAspect(window.innerWidth / Math.max(1, window.innerHeight));
    });

    const canvas = $<HTMLCanvasElement>("scene-canvas");
    const updateNdc = (clientX: number, clientY: number) => {
      this.pointerNdc.x = (clientX / window.innerWidth) * 2 - 1;
      this.pointerNdc.y = -(clientY / window.innerHeight) * 2 + 1;
      this.world.setPointerParallax(this.pointerNdc.x, this.pointerNdc.y);
      this.fireflies.pickAtNdc(this.pointerNdc.x, this.pointerNdc.y, this.world.camera);
    };

    canvas.addEventListener("pointermove", (e) => {
      updateNdc(e.clientX, e.clientY);
      if (this.isPointerDown && this.isPlayingSession) {
        this.swipePoints.push({ x: e.clientX, y: e.clientY, at: performance.now() });
        const hovered = this.fireflies.getHoveredId();
        if (hovered) this.attemptCatch(hovered);
      }
    });

    canvas.addEventListener("pointerdown", (e) => {
      this.isPointerDown = true;
      this.showKeycapHints = false;
      this.swipePoints = [{ x: e.clientX, y: e.clientY, at: performance.now() }];
      updateNdc(e.clientX, e.clientY);
      if (!this.isPlayingSession) return;
      const hovered = this.fireflies.getHoveredId();
      if (hovered) this.attemptCatch(hovered);
    });

    window.addEventListener("pointerup", () => {
      this.isPointerDown = false;
      this.swipePoints.length = 0;
      $("swipe-polyline").setAttribute("points", "");
    });

    // Search & filter toolbar
    $<HTMLInputElement>("song-search").addEventListener("input", (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value;
      this.renderSongGrid();
    });

    document.querySelectorAll<HTMLButtonElement>(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.activeFilter = (btn.dataset.filter as "all" | "es" | "zh" | "review") || "all";
        this.renderSongGrid();
      });
    });

    $("btn-shuffle").addEventListener("click", () => {
      const pool = this.getFilteredManifest();
      const pickList = pool.length ? pool : this.manifest;
      if (!pickList.length) return;
      const chosen = pickList[Math.floor(Math.random() * pickList.length)];
      void this.startManifestSong(chosen);
    });

    // Controls & HUD
    const blurOnRelease = (el: HTMLInputElement) => {
      el.addEventListener("change", () => el.blur());
      el.addEventListener("pointerup", () => el.blur());
    };

    $<HTMLSelectElement>("select-pace").addEventListener("change", (e) => {
      this.applyPaceMode((e.target as HTMLSelectElement).value as PaceMode, false);
    });

    $("btn-pace").addEventListener("click", () => {
      const order: PaceMode[] = ["relaxed", "standard", "brisk"];
      const next = order[(order.indexOf(this.paceMode) + 1) % order.length];
      this.applyPaceMode(next, true);
    });

    const menuDecoySlider = $<HTMLInputElement>("menu-decoy-slider");
    menuDecoySlider.addEventListener("input", () => {
      this.applyDecoyPercent(Number(menuDecoySlider.value), false);
    });
    blurOnRelease(menuDecoySlider);

    const hudDecoySlider = $<HTMLInputElement>("hud-decoy-slider");
    hudDecoySlider.addEventListener("input", () => {
      this.applyDecoyPercent(Number(hudDecoySlider.value), false);
    });
    hudDecoySlider.addEventListener("change", () => {
      this.applyDecoyPercent(Number(hudDecoySlider.value), true);
      hudDecoySlider.blur();
    });
    hudDecoySlider.addEventListener("pointerup", () => hudDecoySlider.blur());

    const hudVolSlider = $<HTMLInputElement>("hud-vol-slider");
    hudVolSlider.addEventListener("input", () => {
      this.applyVolumePercent(Number(hudVolSlider.value));
    });
    blurOnRelease(hudVolSlider);

    $<HTMLSelectElement>("select-lang-mode").addEventListener("change", (e) => {
      const next = (e.target as HTMLSelectElement).value as FireflyLanguageMode;
      this.applyLanguageMode(next);
    });

    $("btn-lang-mode").addEventListener("click", () => {
      const order: FireflyLanguageMode[] = ["both", "primary", "english"];
      const next = order[(order.indexOf(this.languageMode) + 1) % order.length];
      this.applyLanguageMode(next);
    });

    $<HTMLSelectElement>("select-assist").addEventListener("change", (e) => {
      this.applyAssistMode((e.target as HTMLSelectElement).value as AssistMode, false);
    });

    $("btn-mode").addEventListener("click", () => {
      const order: AssistMode[] = ["guided", "immersion", "zen"];
      const next = order[(order.indexOf(this.assistMode) + 1) % order.length];
      this.applyAssistMode(next, true);
    });

    $("btn-speed").addEventListener("click", () => {
      this.speedIndex = (this.speedIndex + 1) % SPEED_STEPS.length;
      const rate = SPEED_STEPS[this.speedIndex];
      this.audio.setPlaybackRate(rate);
      $("btn-speed").textContent = `${rate.toFixed(rate === 1 ? 1 : 2)}×`;
      this.showToast(`Tempo ${rate}×`, "good");
    });

    $("btn-sfx").addEventListener("click", () => {
      const next = !this.audio.isSfxEnabled();
      this.audio.setSfxEnabled(next);
      const btn = $("btn-sfx");
      btn.textContent = next ? "♪ SFX" : "♪ Muted";
      btn.classList.toggle("muted-state", !next);
    });

    $("btn-skip-intro").addEventListener("click", () => this.skipToNextLyric());
    $("btn-play-pause").addEventListener("click", () => void this.togglePlayPause());

    $("btn-songs").addEventListener("click", () => {
      this.audio.pause();
      this.isPlayingSession = false;
      $("btn-play-pause").textContent = "▶";
      this.renderSongGrid();
      $("overlay-menu").classList.remove("hidden");
    });

    const slider = $<HTMLInputElement>("seek-slider");
    slider.addEventListener("input", () => {
      this.isScrubbing = true;
      $("hud-clock").textContent = `${formatClock(Number(slider.value))} / ${formatClock(this.audio.duration)}`;
    });
    slider.addEventListener("change", () => {
      const t = Number(slider.value);
      this.seekSessionTo(t);
      this.isScrubbing = false;
      slider.blur();
    });
    slider.addEventListener("pointerup", () => slider.blur());

    $("btn-study-deck").addEventListener("click", () => this.openStudyModal(false));
    $("btn-open-deck-menu").addEventListener("click", () => this.openStudyModal(false));
    $("btn-close-study").addEventListener("click", () => {
      $("overlay-study").classList.add("hidden");
      if (this.activeSongId && !this.audio.playing && this.isPlayingSession) {
        void this.audio.play();
        $("btn-play-pause").textContent = "❚❚";
      }
    });

    $("btn-clear-mastered").addEventListener("click", () => {
      this.studyDeck.clearAll();
      this.updateDeckBadges();
      this.updateStatsHud();
      this.renderStudyList();
      this.renderSongGrid();
    });

    $("btn-replay-song").addEventListener("click", () => {
      $("overlay-study").classList.add("hidden");
      if (!this.activeSongId) return;
      this.flaggedInCurrentSong.clear();
      this.fireflies.clear();
      this.audio.seek(0);
      this.scheduler.setViewportAspect(window.innerWidth / Math.max(1, window.innerHeight));
      this.scheduler.loadSegments(this.activeSegments, this.paceMode, this.activePrimaryLang, this.languageMode);
      this.paperViz.configureSong(this.activeSongTitle, this.activeSegments, this.audio.duration || 180);
      this.isPlayingSession = true;
      this.updateStatsHud();
      void this.audio.play();
      $("btn-play-pause").textContent = "❚❚";
    });

    $("btn-next-song").addEventListener("click", () => this.playNextSongInManifest());
    $("btn-help").addEventListener("click", () => $("overlay-help").classList.remove("hidden"));
    $("btn-close-help").addEventListener("click", () => $("overlay-help").classList.add("hidden"));

    // Custom importer
    $<HTMLInputElement>("custom-audio").addEventListener("change", (e) => {
      const file = (e.target as HTMLInputElement).files?.[0] ?? null;
      this.customAudioFile = file;
      this.updateCustomButton();
    });
    $<HTMLInputElement>("custom-json").addEventListener("change", async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0] ?? null;
      this.customTimingText = file ? await file.text() : null;
      this.updateCustomButton();
    });
    $("btn-play-custom").addEventListener("click", () => void this.startCustomSong());

    // Keyboard shortcuts
    window.addEventListener("keydown", (e) => {
      const targetEl = e.target as HTMLElement | null;
      if (
        targetEl?.tagName === "TEXTAREA" ||
        targetEl?.tagName === "SELECT" ||
        (targetEl?.tagName === "INPUT" && (targetEl as HTMLInputElement).type !== "range")
      ) {
        return;
      }

      if (e.key === "Escape") {
        if (!$("overlay-help").classList.contains("hidden")) {
          $("overlay-help").classList.add("hidden");
        } else if (!$("overlay-study").classList.contains("hidden")) {
          $("overlay-study").classList.add("hidden");
        } else if (this.isPlayingSession) {
          this.audio.pause();
          this.isPlayingSession = false;
          this.renderSongGrid();
          $("overlay-menu").classList.remove("hidden");
        }
        return;
      }

      if (!$("overlay-menu").classList.contains("hidden") || !$("overlay-study").classList.contains("hidden")) {
        return;
      }

      if (e.key === "p" || e.key === "P") {
        void this.togglePlayPause();
      } else if (e.key === "r" || e.key === "R") {
        this.openStudyModal(false);
      } else if (e.key === "Tab" || e.key === "ArrowRight") {
        e.preventDefault();
        this.skipToNextLyric();
      } else if (e.key === " ") {
        e.preventDefault();
        this.showKeycapHints = true;
        const hovered = this.fireflies.getHoveredId();
        if (hovered) {
          this.attemptCatch(hovered);
        } else if (this.assistMode === "guided") {
          const activeCue = this.scheduler.getActiveCue(this.audio.currentTime);
          const match = activeCue
            ? this.scheduler.getActiveFireflies().find((f) => f.targetCueId === activeCue.id)
            : undefined;
          if (match) this.attemptCatch(match.id);
        }
      } else if (["1", "2", "3", "4"].includes(e.key)) {
        this.showKeycapHints = true;
        const idx = Number(e.key) - 1;
        const order = this.fireflies.getQuickPickOrder(this.world.camera);
        if (order[idx]) this.attemptCatch(order[idx]);
      }
    });
  }

  private updateCustomButton() {
    const btn = $<HTMLButtonElement>("btn-play-custom");
    const status = $("custom-status");
    const ready = Boolean(this.customAudioFile && this.customTimingText);
    btn.disabled = !ready;
    if (this.customAudioFile && !this.customTimingText) {
      status.textContent = `Audio ready (${this.customAudioFile.name}) — pick timings JSON`;
    } else if (!this.customAudioFile && this.customTimingText) {
      status.textContent = "Timings ready — pick audio file";
    } else if (ready) {
      status.textContent = "Ready to fly!";
    } else {
      status.textContent = "";
    }
  }

  private formatDecoyTag(pct: number): { short: string; full: string } {
    if (pct <= 0) return { short: "Off", full: "Off (0)" };
    if (pct <= 40) return { short: "Less", full: `Less (${pct}%)` };
    if (pct <= 70) return { short: "Med", full: `Med (${pct}%)` };
    return { short: "More", full: `More (${pct}%)` };
  }

  private applyDecoyPercent(pct: number, showFeedback = false) {
    const safe = Math.max(0, Math.min(100, Math.round(pct)));
    this.decoyPercent = safe;
    const tag = this.formatDecoyTag(safe);
    $<HTMLInputElement>("menu-decoy-slider").value = String(safe);
    $<HTMLInputElement>("hud-decoy-slider").value = String(safe);
    $("menu-decoy-value").textContent = tag.full;
    $("hud-decoy-label").textContent = tag.short;
    try {
      localStorage.setItem(DECOY_LEVEL_STORAGE_KEY, String(safe));
    } catch {
      // ignore
    }
    this.scheduler.setDecoyLevel(safe / 100, this.isPlayingSession ? this.audio.currentTime : undefined);
    if (showFeedback && this.isPlayingSession) {
      this.showToast(safe === 0 ? "Decoys: Off (target lyrics only)" : `Decoys: ${tag.full}`, "good");
    }
  }

  private applyPaceMode(pace: PaceMode, showFeedback = false) {
    this.paceMode = pace;
    $<HTMLSelectElement>("select-pace").value = pace;
    $("btn-pace").textContent = `${PACE_FLIGHT_SECONDS[pace].toFixed(1)}s`;
    try {
      localStorage.setItem(PACE_MODE_STORAGE_KEY, pace);
    } catch {
      // ignore
    }
    this.scheduler.setPace(pace);
    if (showFeedback && this.isPlayingSession) {
      const name = pace === "relaxed" ? "Relaxed" : pace === "brisk" ? "Brisk" : "Standard";
      this.showToast(`Firefly Pace: ${name} (${PACE_FLIGHT_SECONDS[pace].toFixed(1)}s)`, "good");
    }
  }

  private applyAssistMode(mode: AssistMode, showFeedback = false) {
    this.assistMode = mode;
    $<HTMLSelectElement>("select-assist").value = mode;
    const labels: Record<AssistMode, string> = {
      guided: "Guided",
      immersion: "Immersion",
      zen: "Zen Watch",
    };
    $("btn-mode").textContent = labels[mode];
    try {
      localStorage.setItem(ASSIST_MODE_STORAGE_KEY, mode);
    } catch {
      // ignore
    }
    if (showFeedback && this.isPlayingSession) {
      this.showToast(`Guidance: ${labels[mode]}`, "good");
    }
  }

  private applyVolumePercent(pct: number) {
    const safe = Math.max(0, Math.min(100, Math.round(pct)));
    this.volumePercent = safe;
    $<HTMLInputElement>("hud-vol-slider").value = String(safe);
    this.audio.setVolume(safe / 100);
    try {
      localStorage.setItem(VOLUME_STORAGE_KEY, String(safe));
    } catch {
      // ignore
    }
  }

  private syncLangModeControls() {
    const p = this.activePrimaryLang.toUpperCase();
    const labels: Record<FireflyLanguageMode, string> = {
      both: `${p} + EN`,
      primary: `${p} Only`,
      english: "EN Only",
    };
    $("btn-lang-mode").textContent = labels[this.languageMode];
    $<HTMLSelectElement>("select-lang-mode").value = this.languageMode;
  }

  private applyLanguageMode(mode: FireflyLanguageMode) {
    this.languageMode = mode;
    try {
      localStorage.setItem(LANG_MODE_STORAGE_KEY, mode);
    } catch {
      // ignore
    }
    this.syncLangModeControls();
    if (this.isPlayingSession) {
      this.scheduler.setLanguageMode(mode, this.audio.currentTime);
      this.fireflies.clear();
      this.updateStatsHud();
      const desc =
        mode === "both"
          ? `Fireflies: ${this.activePrimaryLang.toUpperCase()} + EN`
          : mode === "primary"
            ? `Fireflies: ${this.activePrimaryLang.toUpperCase()} only`
            : "Fireflies: EN only";
      this.showToast(desc, "good");
    }
  }

  private async togglePlayPause() {
    if (!this.activeSongId) return;
    if (this.audio.playing) {
      this.audio.pause();
      $("btn-play-pause").textContent = "▶";
    } else {
      await this.audio.play();
      $("btn-play-pause").textContent = "❚❚";
    }
  }

  private spawnScreenPop(text: string, kind: "good" | "miss" | "mastered", screenPos: { x: number; y: number } | null) {
    const layer = $("fx-layer");
    const pop = document.createElement("div");
    pop.className = `catch-pop ${kind}`;
    pop.textContent = text;
    pop.style.left = `${screenPos ? screenPos.x : window.innerWidth * 0.5}px`;
    pop.style.top = `${screenPos ? screenPos.y : window.innerHeight * 0.42}px`;
    layer.appendChild(pop);
    window.setTimeout(() => pop.remove(), 880);
  }

  private spawnHapticRipple(resonance: number, screenPos: { x: number; y: number } | null) {
    if (!screenPos) return;
    const layer = $("fx-layer");
    const ring = document.createElement("div");
    ring.className = resonance >= 0.75 ? "haptic-ripple exact" : "haptic-ripple";
    ring.style.left = `${screenPos.x}px`;
    ring.style.top = `${screenPos.y}px`;
    ring.style.opacity = String(0.35 + resonance * 0.45);
    layer.appendChild(ring);
    window.setTimeout(() => ring.remove(), 380);
  }

  private attemptCatch(fireflyId: string) {
    const screenPos = this.fireflies.getFireflyScreenPos(fireflyId, this.world.camera);
    const nowSec = this.audio.currentTime;
    const res = this.scheduler.catchFirefly(fireflyId, nowSec);
    if (res.outcome === "ignored") return;

    if (res.outcome === "caught" && res.cue) {
      const resonance = res.rhythmResonance ?? 0;
      this.paperViz.triggerInkFlash(res.cue.cueKey, performance.now() / 1000);
      this.pen.triggerCatchPulse(res.cue.language, resonance);
      this.fireflies.spawnCatchBurst(fireflyId, false, res.cue.language);
      this.audio.playCatchChime(this.scheduler.stats.streak, resonance);

      // Subtle tactile "micro-haptic" feedback when catching near the vocal beat (no score/judgments)
      if (resonance > 0.05) {
        this.world.triggerMicroHaptic(resonance);
        this.spawnHapticRipple(resonance, screenPos);
        if (resonance >= 0.75 && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          try {
            navigator.vibrate(10);
          } catch {
            // Ignore unsupported or blocked vibration calls
          }
        }
      }

      const reviewKey = `${res.cue.language}:${res.cue.normalized}`;
      const graduated = !this.flaggedInCurrentSong.has(reviewKey)
        ? this.studyDeck.removeIfMatches(this.activeSongId, res.cue.language, res.cue.normalized)
        : undefined;
      if (graduated) {
        this.updateDeckBadges();
        this.spawnScreenPop(`★ Mastered "${res.cue.value}"!`, "mastered", screenPos);
        this.showToast(`★ Mastered "${res.cue.value}" from Study Again!`, "good");
      } else {
        this.spawnScreenPop(`✓ ${res.cue.value}`, "good", screenPos);
        this.showToast(`✓ Caught  ${res.cue.value}`, "good");
      }
    } else if (res.outcome === "wrong" && res.firefly) {
      this.audio.playWrongTap();
      this.fireflies.spawnCatchBurst(fireflyId, true, res.firefly.language);
      this.spawnScreenPop(`Decoy: ${res.firefly.text}`, "miss", screenPos);
      if (res.flaggedCue) {
        this.flaggedInCurrentSong.add(`${res.flaggedCue.language}:${res.flaggedCue.normalized}`);
        this.studyDeck.addFromCue(res.flaggedCue, this.activeSongId, this.activeSongTitle);
        this.updateDeckBadges();
        this.showToast(`Not "${res.firefly.text}" — queued "${res.flaggedCue.value}" to Study Again`, "miss");
      } else {
        this.showToast(`Decoy "${res.firefly.text}" scattered`, "miss");
      }
    }

    this.world.setStreakIntensity(Math.min(1, this.scheduler.stats.streak / 12));
    this.updateStatsHud();
  }

  private showToast(text: string, kind: "good" | "miss") {
    const el = $("catch-toast");
    el.textContent = text;
    el.className = `catch-toast visible ${kind}`;
    window.clearTimeout(this.toastTimeout);
    this.toastTimeout = window.setTimeout(() => {
      el.classList.remove("visible");
    }, 1500);
  }

  private updateStatsHud() {
    $("hud-caught").textContent = String(this.scheduler.stats.caught);
    $("hud-streak").textContent = String(this.scheduler.stats.streak);
    $("hud-review").textContent = String(
      this.activeSongId ? this.studyDeck.count(this.activeSongId) : this.scheduler.stats.missed,
    );
  }

  private updateDeckBadges() {
    const count = String(this.studyDeck.count());
    $("hud-deck-badge").textContent = count;
    $("menu-deck-count").textContent = count;
  }

  private openStudyModal(songEnded: boolean) {
    if (this.audio.playing) {
      this.audio.pause();
      $("btn-play-pause").textContent = "▶";
    }
    $("study-eyebrow").textContent = songEnded ? "Song Complete · Cliffside Journal" : "No-Fail Study Journal";
    $("study-title").textContent = songEnded ? `${this.activeSongTitle} — Review` : "Words to Study Again";

    const s = this.scheduler.stats;
    const acc = s.totalTargets > 0 ? Math.round((s.caught / s.totalTargets) * 100) : 0;
    const summary = $("study-summary");
    summary.innerHTML = `
      <div class="summary-pill">Caught: <strong>${s.caught} / ${s.totalTargets} (${acc}%)</strong></div>
      <div class="summary-pill">Best Streak: <strong>${s.bestStreak}</strong></div>
      <div class="summary-pill">Study Queue: <strong>${this.studyDeck.count()}</strong></div>
    `;

    this.renderStudyList();
    $("overlay-study").classList.remove("hidden");
  }

  private renderStudyList() {
    const listEl = $("study-list");
    listEl.replaceChildren();
    const items = this.studyDeck.list();

    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "subtitle";
      empty.textContent = "All clear! No words currently need extra study. Enjoy the sunset or replay any song.";
      listEl.appendChild(empty);
      return;
    }

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "study-item";
      row.innerHTML = `
        <div>
          <div class="study-word">${escapeHtml(item.word)} <small style="font-size:13px;opacity:.7">(${escapeHtml(item.language.toUpperCase())})</small></div>
          <div class="study-context">${escapeHtml(item.primaryLine || item.translationLine)}${
            item.primaryLine && item.translationLine ? ` — <em>${escapeHtml(item.translationLine)}</em>` : ""
          }</div>
          <div class="study-context" style="opacity:.7">${escapeHtml(item.songTitle)} · missed ${item.missCount}×</div>
        </div>
        <div class="study-item-actions"></div>
      `;
      const actions = row.querySelector(".study-item-actions")!;
      const manifestSong = this.manifest.find((s) => s.id === item.songId);

      if (item.songId === this.activeSongId || manifestSong) {
        const jumpBtn = document.createElement("button");
        jumpBtn.className = "pill-btn primary";
        jumpBtn.textContent = "Practice Phrase";
        jumpBtn.addEventListener("click", () => {
          $("overlay-study").classList.add("hidden");
          if (item.songId === this.activeSongId) {
            this.seekSessionTo(item.jumpTime);
            this.isPlayingSession = true;
            void this.audio.play();
            $("btn-play-pause").textContent = "❚❚";
          } else if (manifestSong) {
            void this.startManifestSong(manifestSong, item.jumpTime);
          }
        });
        actions.appendChild(jumpBtn);
      }

      const masterBtn = document.createElement("button");
      masterBtn.className = "pill-btn";
      masterBtn.textContent = "Mastered ✓";
      masterBtn.addEventListener("click", () => {
        this.studyDeck.markMastered(item.key);
        this.updateDeckBadges();
        this.updateStatsHud();
        this.renderStudyList();
        this.renderSongGrid();
      });
      actions.appendChild(masterBtn);

      listEl.appendChild(row);
    }
  }

  private updateCueWhisper(songTime: number) {
    if (!this.isPlayingSession) return;
    const seg = displaySegmentAt(this.activeSegments, songTime);
    const hintBox = $("cue-hint");
    if (!seg) {
      hintBox.classList.add("hidden");
      return;
    }
    hintBox.classList.remove("hidden");

    const activeCue = this.scheduler.getActiveCue(songTime);
    const lang = activeCue?.language ?? (!seg.primary && seg.translation ? "en" : this.activePrimaryLang);
    const badge = $("cue-lang-badge");
    badge.textContent = lang.toUpperCase();
    badge.classList.toggle("en", lang === "en");
    badge.classList.toggle("zh", lang === "zh");

    const buildMasked = (words: Segment["words"], joiner: string) =>
      words
        .map((w) => {
          const st = this.scheduler.wordStatuses.get(makeWordKey(w));
          if (this.assistMode === "zen" || st === "caught" || st === "auto") return w.value;
          if (st === "missed") return `[${w.value}]`;
          return this.assistMode === "guided" ? "•".repeat(Math.min(6, Math.max(1, w.value.length))) : "___";
        })
        .join(joiner);

    const joiner = this.activePrimaryLang === "zh" ? "" : " ";
    $("cue-target").textContent = seg.words.length
      ? buildMasked(seg.words, joiner)
      : buildMasked(seg.translationWords, " ");
    $("cue-sub").textContent = seg.words.length ? seg.translation : "English vocal";
  }

  private updateInstrumentalAndOverlayFx(songTime: number) {
    // Instrumental skip pill when next lyric is > 6s ahead
    const pill = $("instrumental-pill");
    if (this.isPlayingSession) {
      const nextCue = this.scheduler.getNextUpcomingCue(songTime);
      const wait = nextCue ? nextCue.start - songTime : 0;
      if (nextCue && wait > 6.0) {
        pill.classList.remove("hidden");
        $("instrumental-label").textContent = `♪ Instrumental · Next lyric in ${Math.ceil(wait)}s`;
      } else {
        pill.classList.add("hidden");
      }
    } else {
      pill.classList.add("hidden");
    }

    // Swipe trail polyline decay
    const now = performance.now();
    this.swipePoints = this.swipePoints.filter((pt) => now - pt.at < 240);
    $("swipe-polyline").setAttribute(
      "points",
      this.swipePoints.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" "),
    );

    // Quick-pick [1..4] keycap markers when using keyboard
    const keycapLayer = $("keycap-layer");
    if (this.isPlayingSession && this.showKeycapHints) {
      const picks = this.fireflies.getQuickPickScreenPositions(this.world.camera);
      keycapLayer.classList.remove("hidden");
      keycapLayer.replaceChildren();
      for (const p of picks) {
        const chip = document.createElement("span");
        chip.className = "keycap-chip";
        chip.textContent = String(p.key);
        chip.style.left = `${p.x.toFixed(1)}px`;
        chip.style.top = `${p.y.toFixed(1)}px`;
        keycapLayer.appendChild(chip);
      }
    } else {
      keycapLayer.classList.add("hidden");
    }
  }

  private loop(nowMs: number) {
    const dt = Math.min(0.05, Math.max(0.001, (nowMs - this.lastTimeMs) / 1000));
    this.lastTimeMs = nowMs;
    this.elapsedSeconds += dt;

    const songTime = this.isPlayingSession ? this.audio.currentTime : this.elapsedSeconds;

    if (this.isPlayingSession) {
      const { newlyMissed } = this.scheduler.update(songTime, this.assistMode);
      if (newlyMissed.length > 0) {
        for (const cue of newlyMissed) {
          this.studyDeck.addFromCue(cue, this.activeSongId, this.activeSongTitle);
        }
        this.updateDeckBadges();
        this.updateStatsHud();
      }

      if (!this.isScrubbing) {
        const dur = this.audio.duration || 180;
        $<HTMLInputElement>("seek-slider").value = String(songTime);
        $("hud-clock").textContent = `${formatClock(songTime)} / ${formatClock(dur)}`;
      }
      this.updateCueWhisper(songTime);
    }

    const { frame, penTarget } = this.paperViz.draw(
      songTime,
      this.isPlayingSession ? this.audio.getAnalyser() : undefined,
      this.scheduler.wordStatuses,
      this.scheduler.wordCaughtAt,
      this.assistMode,
      nowMs,
    );

    this.world.update(this.elapsedSeconds, frame);
    this.pen.update(dt, this.elapsedSeconds, penTarget, this.world, frame.beat);

    const activeCue = this.isPlayingSession ? this.scheduler.getActiveCue(songTime) : undefined;
    const paperDropPos = this.world.paperUvToWorld(penTarget.u, penTarget.v, 0.015);
    const resolveDropPos = (cueKey?: string) => {
      const uv = this.paperViz.getWordPaperUv(cueKey);
      return uv ? this.world.paperUvToWorld(uv.u, uv.v, 0.015) : paperDropPos;
    };

    this.fireflies.update(
      this.scheduler.fireflies,
      songTime,
      this.elapsedSeconds,
      this.assistMode,
      activeCue?.id,
      paperDropPos,
      this.pen.nibWorldPos,
      this.world.camera,
      resolveDropPos,
    );

    this.updateInstrumentalAndOverlayFx(songTime);
    this.renderer.render(this.world.scene, this.world.camera);
    requestAnimationFrame((t) => this.loop(t));
  }
}

const app = new HorizonInkApp();
void app.init();
