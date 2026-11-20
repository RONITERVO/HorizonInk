import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LyricScheduler, PACE_FLIGHT_SECONDS } from "../src/game/LyricScheduler";
import { StudyDeck } from "../src/game/StudyDeck";
import {
  convertGeminiJson,
  extractOtherSongVocabulary,
  normalizeWordKey,
} from "../src/lyrics/geminiImport";
import {
  computeSafeHalfSpreadX,
  evaluateFireflyDepth,
  FIREFLY_CAMERA_Z,
  FIREFLY_CATCH_Z,
  FIREFLY_ORIGIN_Z,
} from "../src/scene/fireflyTrajectory";
import type { SongManifestEntry } from "../src/types";

describe("Gemini bilingual import & 36-song library integrity", () => {
  it("parses all 36 bundled song JSONs cleanly and keeps public/songs strictly paired for Visual Music Lyrics", () => {
    const manifestPath = resolve(__dirname, "../public/songs-manifest.json");
    const manifestRaw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw) as SongManifestEntry[];
    expect(manifest.length).toBe(36);

    // Ensure public/songs contains ONLY <id>.m4a and <id>.json pairs (no clutter for drag-and-drop)
    const publicSongsDir = resolve(__dirname, "../public/songs");
    const files = readdirSync(publicSongsDir);
    expect(files.length).toBe(72);
    for (const song of manifest) {
      expect(files).toContain(`${song.id}.m4a`);
      expect(files).toContain(`${song.id}.json`);
    }

    for (const song of manifest) {
      const jsonPath = resolve(publicSongsDir, `${song.id}.json`);
      const text = readFileSync(jsonPath, "utf8");
      const rawRows = JSON.parse(text) as Array<{
        text: string;
        start: number;
        end: number;
        language: string;
        phrase_id: string;
        uncertain: boolean;
      }>;

      // Strict Visual-Music-Lyrics invariants on raw JSON
      for (const row of rawRows) {
        expect(row.text.trim().length).toBeGreaterThan(0);
        expect(row.start).toBeGreaterThanOrEqual(0);
        expect(row.end).toBeGreaterThan(row.start);
        expect(row.end).toBeLessThanOrEqual(song.duration + 0.05);
        expect(["es", "en"]).toContain(row.language);
        expect(typeof row.uncertain).toBe("boolean");
        expect(row.phrase_id.length).toBeGreaterThan(0);
      }

      // HorizonInk parsing & native-leading-English ordering
      const parsed = convertGeminiJson(text, {
        title: song.title,
        lyrics: song.lyricsText,
        primaryLanguage: song.primaryLanguage,
      });
      expect(parsed.primaryLanguage).toBe(song.primaryLanguage);
      expect(parsed.segments.length).toBeGreaterThan(5);

      const bilingualSegs = parsed.segments.filter((s) => s.words.length > 0 && s.translationWords.length > 0);
      expect(bilingualSegs.length).toBeGreaterThan(3);
      for (const seg of bilingualSegs) {
        expect(seg.words[0].start).toBeLessThanOrEqual(seg.translationWords[0].start);
      }

      // Portable exports exist for every ready track
      for (const [sub, ext] of [
        ["lrc", ".lrc"],
        ["vtt", ".vtt"],
        ["srt", ".srt"],
        ["segments", ".segments.json"],
        ["lyrics", ".txt"],
      ]) {
        expect(existsSync(resolve(__dirname, "../library/exports", sub, `${song.id}${ext}`))).toBe(true);
      }
    }

    // Catalog reports all 36 tracks ready and 0 missing
    const catalog = JSON.parse(readFileSync(resolve(__dirname, "../library/catalog.json"), "utf8")) as Array<{
      id: string;
      status: string;
    }>;
    expect(catalog.length).toBe(36);
    const ready = catalog.filter((c) => c.status === "ready");
    expect(ready.length).toBe(36);
    const missing = catalog.filter((c) => c.status === "missing-timing");
    expect(missing.length).toBe(0);
    for (const r of ready) {
      expect(existsSync(resolve(__dirname, "../library/raw-timings", `${r.id}.txt`))).toBe(true);
      expect(existsSync(resolve(__dirname, "../library/missing-timings", `${r.id}.m4a`))).toBe(false);
      expect(existsSync(resolve(__dirname, "../library/missing-timings", `${r.id}.txt`))).toBe(false);
    }
    const sourcesRaw = readFileSync(resolve(__dirname, "../scripts/song-sources.json"), "utf8");
    expect(sourcesRaw).not.toMatch(/Downloads/i);
  });

  it("auto-detects Chinese (zh) songs and spawns only Chinese decoys for Chinese cues", () => {
    const text = readFileSync(resolve(__dirname, "../public/songs/moving-ink.json"), "utf8");
    const parsed = convertGeminiJson(text, { title: "Moving Ink" });
    expect(parsed.primaryLanguage).toBe("zh");

    const scheduler = new LyricScheduler();
    scheduler.loadSegments(parsed.segments, "standard", parsed.primaryLanguage);
    scheduler.update(25, "guided");
    scheduler.update(32, "guided");

    const zhTargets = scheduler.cues.filter((c) => c.language === "zh");
    expect(zhTargets.length).toBeGreaterThan(50);

    const activeFireflies = scheduler.getActiveFireflies();
    for (const ff of activeFireflies) {
      expect(["zh", "en"]).toContain(ff.language);
    }
  });
});

describe("LyricScheduler critical timing, spatial separation & no-fail study loop", () => {
  const sampleJson = JSON.stringify([
    { text: "Abro", start: 30.06, end: 30.44, language: "es", phrase_id: "p1" },
    { text: "los", start: 30.50, end: 30.72, language: "es", phrase_id: "p1" },
    { text: "ojos", start: 30.82, end: 31.26, language: "es", phrase_id: "p1" },
    { text: "I", start: 31.42, end: 31.56, language: "en", phrase_id: "p2" },
    { text: "open", start: 31.68, end: 31.88, language: "en", phrase_id: "p2" },
    { text: "y", start: 38.90, end: 38.98, language: "es", phrase_id: "p3" },
  ]);

  it("spawns Spanish words ahead of English echoes, keeps catchY above paper, and tracks next upcoming cue", () => {
    const { segments } = convertGeminiJson(sampleJson, { title: "Test" });
    const scheduler = new LyricScheduler();
    scheduler.loadSegments(segments, "standard");

    expect(scheduler.cues[0].value).toBe("Abro");
    expect(scheduler.cues[0].language).toBe("es");
    expect(scheduler.cues[0].spawnTime).toBeCloseTo(30.06 - PACE_FLIGHT_SECONDS.standard, 2);
    expect(scheduler.cues[3].language).toBe("en");
    expect(scheduler.cues[0].spawnTime).toBeLessThan(scheduler.cues[3].spawnTime);

    const shortWord = scheduler.cues.find((c) => c.value === "y")!;
    expect(shortWord.tooLateTime - shortWord.start).toBeCloseTo(1.05, 4);

    // Upcoming cue lookup for instrumental skip pill
    expect(scheduler.getNextUpcomingCue(10)?.value).toBe("Abro");
    expect(scheduler.getNextUpcomingCue(34)?.value).toBe("y");

    // Flying fireflies stay cleanly above the A4 paper inside the in-frame catch band
    scheduler.update(28.0, "guided");
    for (const ff of scheduler.getActiveFireflies()) {
      expect(ff.catchY).toBeGreaterThanOrEqual(1.18);
      expect(ff.catchY).toBeLessThanOrEqual(1.48);
    }
  });

  it("rewards timely catches, graduates StudyDeck items automatically, and supports phrase replay", () => {
    const { segments } = convertGeminiJson(sampleJson, { title: "Test" });
    const scheduler = new LyricScheduler();
    scheduler.loadSegments(segments, "standard");

    scheduler.update(26.5, "guided");
    scheduler.update(30.05, "guided");

    const targetFirefly = scheduler.getActiveFireflies().find((f) => f.isTarget && f.text === "Abro");
    expect(targetFirefly).toBeDefined();

    const catchRes = scheduler.catchFirefly(targetFirefly!.id, 30.05);
    expect(catchRes.outcome).toBe("caught");
    expect(catchRes.accuracy).toBe("perfect");
    expect(catchRes.rhythmResonance).toBe(1);
    expect(scheduler.stats.caught).toBe(1);
    expect(scheduler.stats.streak).toBe(1);
    expect(scheduler.wordCaughtAt.get(targetFirefly!.cueKey!)).toBe(30.05);

    const decoy = scheduler.getActiveFireflies().find((f) => !f.isTarget);
    if (decoy) {
      const wrongRes = scheduler.catchFirefly(decoy.id, 30.2);
      expect(wrongRes.outcome).toBe("wrong");
      expect(scheduler.stats.streak).toBe(0);
    }

    const { newlyMissed } = scheduler.update(33.5, "guided");
    const ojosCue = newlyMissed.find((c) => c.value === "ojos");
    expect(ojosCue).toBeDefined();
    expect(scheduler.stats.missed).toBeGreaterThanOrEqual(1);

    // Auto-mastery graduation in StudyDeck
    const deck = new StudyDeck();
    deck.clearAll();
    deck.addFromCue(ojosCue!, "test-song", "Test Song");
    expect(deck.count("test-song")).toBe(1);
    const graduated = deck.removeIfMatches("test-song", ojosCue!.language, ojosCue!.normalized);
    expect(graduated?.word).toBe("ojos");
    expect(deck.count("test-song")).toBe(0);

    // Seeking back to 26s respawns missed phrase cleanly and clears future caught timestamps
    scheduler.syncToTime(26.0);
    const ojosAfterSeek = scheduler.cues.find((c) => c.value === "ojos")!;
    expect(ojosAfterSeek.status).toBe("pending");
    expect(scheduler.wordCaughtAt.has(targetFirefly!.cueKey!)).toBe(false);
  });

  it("enforces strict monotonic Z-depth and screen scale so later fireflies never fly closer than earlier ones", () => {
    // Mix early cues (start < flightSeconds) and closely spaced cues + decoys
    const denseJson = JSON.stringify([
      { text: "Uno", start: 0.8, end: 1.2, language: "es", phrase_id: "p0" },
      { text: "Dos", start: 1.4, end: 1.9, language: "es", phrase_id: "p0" },
      { text: "Tres", start: 2.1, end: 2.6, language: "es", phrase_id: "p0" },
      { text: "One", start: 2.75, end: 3.1, language: "en", phrase_id: "p1" },
      { text: "Two", start: 3.3, end: 3.7, language: "en", phrase_id: "p1" },
      { text: "Sol", start: 6.2, end: 6.7, language: "es", phrase_id: "p2" },
      { text: "Luna", start: 6.8, end: 7.3, language: "es", phrase_id: "p2" },
      { text: "Sun", start: 7.45, end: 7.9, language: "en", phrase_id: "p3" },
    ]);

    const { segments } = convertGeminiJson(denseJson, { title: "Depth Ordering Test" });
    const scheduler = new LyricScheduler();
    scheduler.loadSegments(segments, "standard");

    // Simulate frame-by-frame playback across early and mid-song windows
    for (let t = 0; t <= 8.5; t += 0.2) {
      scheduler.update(t, "guided");
      const flying = scheduler.getActiveFireflies();
      for (const ff of flying) {
        expect(ff.originZ).toBe(FIREFLY_ORIGIN_Z);
        expect(ff.catchZ).toBe(FIREFLY_CATCH_Z);
      }

      // Check pairwise: any firefly with strictly earlier idealTime must be strictly closer onscreen
      for (let i = 0; i < flying.length; i += 1) {
        for (let j = i + 1; j < flying.length; j += 1) {
          const a = flying[i];
          const b = flying[j];
          const da = evaluateFireflyDepth(t, a.idealTime, a.flightSeconds);
          const db = evaluateFireflyDepth(t, b.idealTime, b.flightSeconds);
          expect(Number.isFinite(da.badgeWorldHeight)).toBe(true);
          expect(Number.isFinite(db.apparentScale)).toBe(true);
          if (a.idealTime < b.idealTime) {
            expect(da.z).toBeGreaterThan(db.z);
            if (db.dist > 0.55) {
              expect(da.apparentScale).toBeGreaterThan(db.apparentScale);
            } else {
              expect(da.apparentScale).toBeGreaterThanOrEqual(db.apparentScale);
            }
          } else if (b.idealTime < a.idealTime) {
            expect(db.z).toBeGreaterThan(da.z);
            if (da.dist > 0.55) {
              expect(db.apparentScale).toBeGreaterThan(da.apparentScale);
            } else {
              expect(db.apparentScale).toBeGreaterThanOrEqual(da.apparentScale);
            }
          } else {
            // Paired decoy and its target share the exact same Z-depth plane
            expect(da.z).toBeCloseTo(db.z, 6);
          }
        }
      }
    }
  });

  it("lands behind the paper at idealTime, keeps traveling past camera, adapts horizontal spread, and exposes subtle rhythmResonance", () => {
    // 1. At idealTime, firefly sits behind the A4 paper & cliff desk (z = -1.50), then keeps moving past paper and camera
    const atBeat = evaluateFireflyDepth(10.0, 10.0, 4.0);
    expect(atBeat.z).toBeCloseTo(-1.5, 2);
    expect(atBeat.z).toBeLessThan(-0.7);
    expect(atBeat.z).toBeLessThan(-1.33);
    const late065 = evaluateFireflyDepth(10.65, 10.0, 4.0);
    const pastCamera = evaluateFireflyDepth(11.45, 10.0, 4.0);
    expect(late065.z).toBeGreaterThan(-0.7);
    expect(late065.z).toBeLessThan(FIREFLY_CAMERA_Z);
    expect(pastCamera.z).toBeGreaterThan(FIREFLY_CAMERA_Z);
    expect(Number.isFinite(pastCamera.badgeWorldHeight)).toBe(true);
    expect(Number.isFinite(pastCamera.apparentScale)).toBe(true);

    // 1b. Continuous rhythmResonance peaks near exact vocal beat and stays 0 when caught far early
    const { segments: resSegs } = convertGeminiJson(sampleJson, { title: "Resonance Test" });
    const resSched = new LyricScheduler();
    resSched.loadSegments(resSegs, "standard");
    resSched.update(27.0, "guided");
    resSched.update(28.0, "guided");
    const earlyAbro = resSched.getActiveFireflies().find((f) => f.isTarget && f.text === "Abro")!;
    const farEarly = resSched.catchFirefly(earlyAbro.id, 28.0);
    expect(farEarly.outcome).toBe("caught");
    expect(farEarly.rhythmResonance).toBe(0);

    const nearLos = resSched.getActiveFireflies().find((f) => f.isTarget && f.text === "los")!;
    const nearBeat = resSched.catchFirefly(nearLos.id, nearLos.idealTime - 0.35);
    expect(nearBeat.outcome).toBe("caught");
    expect(nearBeat.rhythmResonance).toBeGreaterThan(0);
    expect(nearBeat.rhythmResonance).toBeLessThan(1);

    // 2. Viewport aspect spread grows monotonically and rescales active fireflies within bounds
    const spreadPortrait = computeSafeHalfSpreadX(0.75);
    const spreadStandard = computeSafeHalfSpreadX(4 / 3);
    const spreadWide = computeSafeHalfSpreadX(16 / 9);
    const spreadUltra = computeSafeHalfSpreadX(21 / 9);
    expect(spreadPortrait).toBeLessThan(spreadStandard);
    expect(spreadStandard).toBeLessThan(spreadWide);
    expect(spreadWide).toBeLessThan(spreadUltra);

    const { segments } = convertGeminiJson(sampleJson, { title: "Spread & Language Test" });
    const scheduler = new LyricScheduler();
    scheduler.setViewportAspect(0.75);
    scheduler.loadSegments(segments, "standard", "es", "both");
    scheduler.update(28.5, "guided");
    for (const ff of scheduler.getActiveFireflies()) {
      expect(Math.abs(ff.catchX)).toBeLessThanOrEqual(spreadPortrait + 0.001);
    }

    // 3. Language filtering: "primary" only queues primary cues while setting English cues to "auto"
    const primaryOnly = new LyricScheduler();
    primaryOnly.loadSegments(segments, "standard", "es", "primary");
    expect(primaryOnly.cues.every((c) => c.language === "es")).toBe(true);
    expect(primaryOnly.cues.length).toBe(4);
    for (const seg of segments) {
      for (const tw of seg.translationWords) {
        const key = `${tw.start.toFixed(2)}:${tw.sourceIndex ?? 0}:${tw.value}`;
        expect(primaryOnly.wordStatuses.get(key)).toBe("auto");
      }
    }

    // "english" only queues English cues while setting primary cues to "auto"
    const englishOnly = new LyricScheduler();
    englishOnly.loadSegments(segments, "standard", "es", "english");
    expect(englishOnly.cues.every((c) => c.language === "en")).toBe(true);
    expect(englishOnly.cues.length).toBe(2);

    // Switching language mode mid-song never creates false missed counts for unplayed cues
    primaryOnly.setLanguageMode("english", 31.0);
    expect(primaryOnly.getLanguageMode()).toBe("english");
    expect(primaryOnly.stats.missed).toBe(0);
    expect(primaryOnly.cues.every((c) => c.language === "en")).toBe(true);
  });

  it("extracts decoys strictly from other songs and scales decoy spawning via the 0..1 slider", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, "../public/songs-manifest.json"), "utf8"),
    ) as SongManifestEntry[];

    // 1. Vocabulary extracted for carbon-dreams excludes carbon-dreams & identical-lyrics sibling one-heartbeat
    const carbonJson = readFileSync(resolve(__dirname, "../public/songs/carbon-dreams.json"), "utf8");
    const carbonParsed = convertGeminiJson(carbonJson, { title: "Carbon Dreams" });
    const carbonVocab = extractOtherSongVocabulary(manifest, "carbon-dreams");
    expect(carbonVocab.es.length).toBeGreaterThan(80);
    expect(carbonVocab.en.length).toBeGreaterThan(80);
    expect(carbonVocab.zh.length).toBeGreaterThan(10);

    const singleSongOnly = extractOtherSongVocabulary(
      manifest.filter((m) => m.id === "carbon-dreams" || m.id === "one-heartbeat"),
      "carbon-dreams",
    );
    expect(singleSongOnly.es.length).toBe(0);
    expect(singleSongOnly.en.length).toBe(0);

    // moving-ink still receives Chinese character decoys strictly from bending-bamboo
    const movingVocab = extractOtherSongVocabulary(manifest, "moving-ink");
    expect(movingVocab.zh.length).toBeGreaterThan(15);

    const countSpawnedDecoys = (level01: number): { spawnedIds: Set<string>; spawnedTexts: string[] } => {
      const sched = new LyricScheduler();
      sched.setCrossSongVocabulary(carbonVocab.es, carbonVocab.en, carbonVocab.zh);
      sched.setDecoyLevel(level01);
      sched.loadSegments(carbonParsed.segments, "standard", "es", "both");
      const spawnedIds = new Set<string>();
      const spawnedTexts: string[] = [];
      for (let t = 0; t <= 85; t += 0.25) {
        sched.update(t, "guided");
        for (const ff of sched.getActiveFireflies()) {
          if (!ff.isTarget && !spawnedIds.has(ff.id)) {
            spawnedIds.add(ff.id);
            spawnedTexts.push(ff.text);
          }
        }
      }
      return { spawnedIds, spawnedTexts };
    };

    // 2. Slider at 0 spawns zero decoys; sliding to 0 mid-song immediately clears flying decoys
    const zeroRun = countSpawnedDecoys(0);
    expect(zeroRun.spawnedIds.size).toBe(0);

    const liveSched = new LyricScheduler();
    liveSched.setCrossSongVocabulary(carbonVocab.es, carbonVocab.en, carbonVocab.zh);
    liveSched.setDecoyLevel(0.85);
    liveSched.loadSegments(carbonParsed.segments, "standard", "es", "both");
    let caughtWithFlyingDecoy = false;
    for (let t = 0; t <= 70; t += 0.25) {
      liveSched.update(t, "guided");
      const activeDecoys = liveSched.getActiveFireflies().filter((f) => !f.isTarget);
      const activeTargets = liveSched.getActiveFireflies().filter((f) => f.isTarget);
      if (activeDecoys.length > 0 && activeTargets.length > 0) {
        liveSched.setDecoyLevel(0, t);
        expect(liveSched.getActiveFireflies().some((f) => !f.isTarget)).toBe(false);
        expect(liveSched.getActiveFireflies().some((f) => f.isTarget)).toBe(true);
        caughtWithFlyingDecoy = true;
        break;
      }
    }
    expect(caughtWithFlyingDecoy).toBe(true);

    // 3. Slider monotonically scales spawned decoys across Less -> Medium -> More
    const lessRun = countSpawnedDecoys(0.2);
    const medRun = countSpawnedDecoys(0.55);
    const moreRun = countSpawnedDecoys(1.0);
    expect(lessRun.spawnedIds.size).toBeGreaterThan(0);
    expect(medRun.spawnedIds.size).toBeGreaterThan(lessRun.spawnedIds.size);
    expect(moreRun.spawnedIds.size).toBeGreaterThan(medRun.spawnedIds.size);

    // 4. Every spawned decoy word is NOT sung in the active song (comes strictly from other songs)
    const activeSongWordKeys = new Set(carbonParsed.allWords.map((w) => normalizeWordKey(w.value)));
    for (const word of moreRun.spawnedTexts) {
      expect(activeSongWordKeys.has(normalizeWordKey(word))).toBe(false);
    }
  });
});
