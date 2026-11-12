import * as THREE from "three";
import "./style.css";
import { SongAudioEngine } from "./audio/SongAudioEngine";
import { LyricScheduler } from "./game/LyricScheduler";
import { StudyDeck } from "./game/StudyDeck";
import { convertGeminiJson, displaySegmentAt } from "./lyrics/geminiImport";
import { FireflyField } from "./scene/FireflyField";
import { MagicalPen } from "./scene/MagicalPen";
import { SunsetCliffWorld } from "./scene/SunsetCliffWorld";
import type { AssistMode, PaceMode, Segment, SongManifestEntry } from "./types";
import { A4PaperVisualizer } from "./visualizer/SketchbookVisualizer";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function formatClock(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

class HorizonInkApp {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly paperViz = new A4PaperVisualizer();
  private readonly world: SunsetCliffWorld;
  private readonly pen: MagicalPen;
  private readonly fireflies: FireflyField;
  private readonly audio = new SongAudioEngine();
  private readonly scheduler = new LyricScheduler();
  private readonly studyDeck = new StudyDeck();

  private manifest: SongManifestEntry[] = [];
  private activeSongId = "";
  private activeSongTitle = "Horizon Ink";
  private activeSegments: Segment[] = [];
  private paceMode: PaceMode = "standard";
  private assistMode: AssistMode = "guided";

  private customAudioFile: File | null = null;
  private customTimingText: string | null = null;

  private isPlayingSession = false;
  private isScrubbing = false;
  private isPointerDown = false;
  private pointerNdc = new THREE.Vector2(0, 0);
  private toastTimeout: number | undefined;
  private lastTimeMs = performance.now();
  private elapsedSeconds = 0;

  constructor() {
    const canvas = $<HTMLCanvasElement>("scene-canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;

    this.world = new SunsetCliffWorld(this.paperViz.outputCanvas, window.innerWidth / window.innerHeight);
    this.pen = new MagicalPen(this.world.scene);
    this.fireflies = new FireflyField(this.world.scene);

    this.bindEvents();
    this.audio.onEnded(() => {
      this.openStudyModal(true);
    });
  }

  async init() {
    // Load bundled handwriting fonts before initial render
    await Promise.allSettled([
      document.fonts.load('700 42px "Caveat"'),
      document.fonts.load('700 40px "Patrick Hand"'),
      document.fonts.ready,
    ]);

    try {
      const resp = await fetch("./songs/manifest.json");
      if (resp.ok) {
        this.manifest = (await resp.json()) as SongManifestEntry[];
      }
    } catch {
      this.manifest = [];
    }

    this.renderSongGrid();
    this.updateDeckBadges();
    void this.preloadCrossSongVocabulary();

    if (this.manifest.length > 0) {
      this.paperViz.configureSong(this.manifest[0].title, [], this.manifest[0].duration);
    }

    requestAnimationFrame((t) => this.loop(t));
  }

  private async preloadCrossSongVocabulary() {
    const extraEs: string[] = [];
    const extraEn: string[] = [];
    await Promise.allSettled(
      this.manifest.map(async (song) => {
        const res = await fetch(song.timingUrl);
        if (!res.ok) return;
        const parsed = convertGeminiJson(await res.text(), { title: song.title, lyrics: song.lyricsText });
        for (const w of parsed.allWords) {
          const clean = w.value.replace(/[.,!?¿¡…]+$/g, "");
          if (w.language === "en") extraEn.push(clean);
          else extraEs.push(clean);
        }
      }),
    );
    this.scheduler.setCrossSongVocabulary(extraEs, extraEn);
  }

  private renderSongGrid() {
    const grid = $("song-grid");
    grid.replaceChildren();

    for (const item of this.manifest) {
      const card = document.createElement("button");
      card.className = "song-card";
      card.innerHTML = `
        <div>
          <div class="song-card-title">${item.title}</div>
          <div class="song-card-sub">${item.subtitle}</div>
        </div>
        <div class="song-card-meta">
          <span>${formatClock(item.duration)}</span>
          <span>${item.wordCount} timed words</span>
        </div>
      `;
      card.addEventListener("click", () => void this.startManifestSong(item));
      grid.appendChild(card);
    }
  }

  private async startManifestSong(item: SongManifestEntry) {
    this.showToast("Loading song & timings…", "good");
    const res = await fetch(item.timingUrl);
    if (!res.ok) {
      this.showToast("Failed to load timing JSON.", "miss");
      return;
    }
    const text = await res.text();
    const converted = convertGeminiJson(text, { title: item.title, lyrics: item.lyricsText });
    const duration = await this.audio.loadUrl(item.audioUrl);

    await this.beginSongSession(item.id, item.title, converted.segments, duration);
  }

  private async startCustomSong() {
    if (!this.customAudioFile || !this.customTimingText) return;
    try {
      const title = this.customAudioFile.name.replace(/\.[^.]+$/, "");
      const converted = convertGeminiJson(this.customTimingText, { title });
      const duration = await this.audio.loadFile(this.customAudioFile);
      await this.beginSongSession(`custom:${title}`, converted.title, converted.segments, duration);
    } catch (err) {
      $("custom-status").textContent = (err as Error).message;
    }
  }

  private async beginSongSession(id: string, title: string, segments: Segment[], duration: number) {
    this.activeSongId = id;
    this.activeSongTitle = title;
    this.activeSegments = segments;

    this.fireflies.clear();
    this.scheduler.loadSegments(segments, this.paceMode);
    this.paperViz.configureSong(title, segments, duration);

    $<HTMLSpanElement>("hud-song-title").textContent = title;
    const slider = $<HTMLInputElement>("seek-slider");
    slider.max = String(Math.max(1, duration));
    slider.value = "0";
    $("hud-clock").textContent = `00:00 / ${formatClock(duration)}`;

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

  private bindEvents() {
    window.addEventListener("resize", () => {
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.world.resize(window.innerWidth, window.innerHeight);
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
        const hovered = this.fireflies.getHoveredId();
        if (hovered) this.attemptCatch(hovered);
      }
    });

    canvas.addEventListener("pointerdown", (e) => {
      this.isPointerDown = true;
      updateNdc(e.clientX, e.clientY);
      if (!this.isPlayingSession) return;
      const hovered = this.fireflies.getHoveredId();
      if (hovered) this.attemptCatch(hovered);
    });

    window.addEventListener("pointerup", () => {
      this.isPointerDown = false;
    });

    // Controls & HUD
    $<HTMLSelectElement>("select-pace").addEventListener("change", (e) => {
      this.paceMode = (e.target as HTMLSelectElement).value as PaceMode;
      this.scheduler.setPace(this.paceMode);
    });

    $<HTMLSelectElement>("select-assist").addEventListener("change", (e) => {
      this.assistMode = (e.target as HTMLSelectElement).value as AssistMode;
      this.syncAssistButton();
    });

    $("btn-mode").addEventListener("click", () => {
      const order: AssistMode[] = ["guided", "immersion", "zen"];
      this.assistMode = order[(order.indexOf(this.assistMode) + 1) % order.length];
      $<HTMLSelectElement>("select-assist").value = this.assistMode;
      this.syncAssistButton();
    });

    $("btn-play-pause").addEventListener("click", () => void this.togglePlayPause());

    $("btn-songs").addEventListener("click", () => {
      this.audio.pause();
      this.isPlayingSession = false;
      $("btn-play-pause").textContent = "▶";
      $("overlay-menu").classList.remove("hidden");
    });

    const slider = $<HTMLInputElement>("seek-slider");
    slider.addEventListener("input", () => {
      this.isScrubbing = true;
      $("hud-clock").textContent = `${formatClock(Number(slider.value))} / ${formatClock(this.audio.duration)}`;
    });
    slider.addEventListener("change", () => {
      const t = Number(slider.value);
      this.audio.seek(t);
      this.scheduler.syncToTime(t);
      this.isScrubbing = false;
      this.updateStatsHud();
    });

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
      this.renderStudyList();
    });

    $("btn-replay-song").addEventListener("click", () => {
      $("overlay-study").classList.add("hidden");
      if (!this.activeSongId) return;
      this.audio.seek(0);
      this.scheduler.loadSegments(this.activeSegments, this.paceMode);
      this.paperViz.configureSong(this.activeSongTitle, this.activeSegments, this.audio.duration || 180);
      this.isPlayingSession = true;
      this.updateStatsHud();
      void this.audio.play();
      $("btn-play-pause").textContent = "❚❚";
    });

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
      if (e.key === "Escape") {
        if (!$("overlay-help").classList.contains("hidden")) {
          $("overlay-help").classList.add("hidden");
        } else if (!$("overlay-study").classList.contains("hidden")) {
          $("overlay-study").classList.add("hidden");
        } else if (this.isPlayingSession) {
          this.audio.pause();
          this.isPlayingSession = false;
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
      } else if (e.key === " ") {
        e.preventDefault();
        const hovered = this.fireflies.getHoveredId();
        if (hovered) {
          this.attemptCatch(hovered);
        } else {
          const activeCue = this.scheduler.getActiveCue(this.audio.currentTime);
          const match = activeCue
            ? this.scheduler.getActiveFireflies().find((f) => f.targetCueId === activeCue.id)
            : undefined;
          if (match) this.attemptCatch(match.id);
        }
      } else if (["1", "2", "3", "4"].includes(e.key)) {
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

  private syncAssistButton() {
    const labels: Record<AssistMode, string> = {
      guided: "Guided",
      immersion: "Immersion",
      zen: "Zen Watch",
    };
    $("btn-mode").textContent = labels[this.assistMode];
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

  private attemptCatch(fireflyId: string) {
    const nowSec = this.audio.currentTime;
    const res = this.scheduler.catchFirefly(fireflyId, nowSec);
    if (res.outcome === "ignored") return;

    if (res.outcome === "caught" && res.cue) {
      const cueKey = `${res.cue.start.toFixed(2)}:${res.cue.value}`;
      this.paperViz.triggerInkFlash(cueKey, performance.now() / 1000);
      this.pen.triggerCatchPulse(res.cue.language === "en");
      this.audio.playCatchChime(this.scheduler.stats.streak, res.accuracy === "perfect");

      const badge = res.accuracy === "perfect" ? "✦ On Beat!" : res.accuracy === "early" ? "✓ Caught" : "✓ Saved";
      this.showToast(`${badge}  ${res.cue.value}`, "good");
    } else if (res.outcome === "wrong" && res.firefly) {
      this.audio.playWrongTap();
      if (res.flaggedCue) {
        this.studyDeck.addFromCue(res.flaggedCue, this.activeSongId, this.activeSongTitle);
        this.updateDeckBadges();
        this.showToast(`Not "${res.firefly.text}" — queued "${res.flaggedCue.value}" to Study Again`, "miss");
      } else {
        this.showToast(`Decoy "${res.firefly.text}" scattered`, "miss");
      }
    }

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
    $("hud-review").textContent = String(this.scheduler.stats.missed);
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
    const summary = $("study-summary");
    summary.innerHTML = `
      <div class="summary-pill">Caught: <strong>${s.caught} / ${s.totalTargets}</strong></div>
      <div class="summary-pill">On-Beat: <strong>${s.perfect}</strong></div>
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
          <div class="study-word">${item.word} <small style="font-size:13px;opacity:.7">(${item.language.toUpperCase()})</small></div>
          <div class="study-context">${item.primaryLine || item.translationLine}${
            item.primaryLine && item.translationLine ? ` — <em>${item.translationLine}</em>` : ""
          }</div>
          <div class="study-context" style="opacity:.7">${item.songTitle} · missed ${item.missCount}×</div>
        </div>
        <div class="study-item-actions"></div>
      `;
      const actions = row.querySelector(".study-item-actions")!;

      if (item.songId === this.activeSongId) {
        const jumpBtn = document.createElement("button");
        jumpBtn.className = "pill-btn primary";
        jumpBtn.textContent = "Practice Phrase";
        jumpBtn.addEventListener("click", () => {
          $("overlay-study").classList.add("hidden");
          this.audio.seek(item.jumpTime);
          this.scheduler.syncToTime(item.jumpTime);
          this.isPlayingSession = true;
          this.updateStatsHud();
          void this.audio.play();
          $("btn-play-pause").textContent = "❚❚";
        });
        actions.appendChild(jumpBtn);
      }

      const masterBtn = document.createElement("button");
      masterBtn.className = "pill-btn";
      masterBtn.textContent = "Mastered ✓";
      masterBtn.addEventListener("click", () => {
        this.studyDeck.markMastered(item.key);
        this.updateDeckBadges();
        this.renderStudyList();
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
    const isEn = activeCue?.language === "en" || (!seg.primary && Boolean(seg.translation));
    const badge = $("cue-lang-badge");
    badge.textContent = isEn ? "EN" : "ES";
    badge.classList.toggle("en", isEn);

    const buildMasked = (words: Segment["words"]) =>
      words
        .map((w) => {
          const st = this.scheduler.wordStatuses.get(`${w.start.toFixed(2)}:${w.value}`);
          if (this.assistMode === "zen" || st === "caught" || st === "auto") return w.value;
          if (st === "missed") return `[${w.value}]`;
          return this.assistMode === "guided" ? "•".repeat(Math.min(6, Math.max(2, w.value.length))) : "___";
        })
        .join(" ");

    $("cue-target").textContent = seg.words.length ? buildMasked(seg.words) : buildMasked(seg.translationWords);
    $("cue-sub").textContent = seg.words.length ? seg.translation : "Intro";
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
      this.assistMode,
      nowMs,
    );

    this.world.update(this.elapsedSeconds, frame);
    this.pen.update(dt, this.elapsedSeconds, penTarget, this.world, frame.beat);

    const activeCue = this.isPlayingSession ? this.scheduler.getActiveCue(songTime) : undefined;
    const paperDropPos = this.world.paperUvToWorld(penTarget.u, penTarget.v, 0.015);
    this.fireflies.update(
      this.scheduler.fireflies,
      songTime,
      this.elapsedSeconds,
      this.assistMode,
      activeCue?.id,
      paperDropPos,
      this.pen.nibWorldPos,
    );

    this.renderer.render(this.world.scene, this.world.camera);
    requestAnimationFrame((t) => this.loop(t));
  }
}

const app = new HorizonInkApp();
void app.init();

