import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LyricScheduler, PACE_FLIGHT_SECONDS } from "../src/game/LyricScheduler";
import { convertGeminiJson } from "../src/lyrics/geminiImport";

describe("Gemini bilingual import & native-first ordering", () => {
  it("parses all bundled song JSONs cleanly with Spanish leading English in bilingual pairs", () => {
    const manifestRaw = readFileSync(resolve(__dirname, "../public/songs/manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as Array<{ id: string; title: string; timingUrl: string; lyricsText?: string }>;
    expect(manifest.length).toBeGreaterThanOrEqual(6);

    for (const song of manifest) {
      const jsonPath = resolve(__dirname, "../public/songs", `${song.id}.json`);
      const text = readFileSync(jsonPath, "utf8");
      const parsed = convertGeminiJson(text, { title: song.title, lyrics: song.lyricsText });
      expect(parsed.segments.length).toBeGreaterThan(5);

      const bilingualSegs = parsed.segments.filter((s) => s.words.length > 0 && s.translationWords.length > 0);
      expect(bilingualSegs.length).toBeGreaterThan(3);
      for (const seg of bilingualSegs) {
        expect(seg.words[0].start).toBeLessThanOrEqual(seg.translationWords[0].start);
      }
    }
  });
});

describe("LyricScheduler critical timing & no-fail study loop", () => {
  const sampleJson = JSON.stringify([
    { text: "Abro", start: 30.06, end: 30.44, language: "es", phrase_id: "p1" },
    { text: "los", start: 30.50, end: 30.72, language: "es", phrase_id: "p1" },
    { text: "ojos", start: 30.82, end: 31.26, language: "es", phrase_id: "p1" },
    { text: "I", start: 31.42, end: 31.56, language: "en", phrase_id: "p2" },
    { text: "open", start: 31.68, end: 31.88, language: "en", phrase_id: "p2" },
    { text: "y", start: 38.90, end: 38.98, language: "es", phrase_id: "p3" },
  ]);

  it("spawns Spanish words ahead of English echoes and guarantees >= 1.05s catch window for ultra-short words", () => {
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
  });

  it("rewards timely catches, treats wrong decoys & late misses without game over, and supports phrase replay", () => {
    const { segments } = convertGeminiJson(sampleJson, { title: "Test" });
    const scheduler = new LyricScheduler();
    scheduler.loadSegments(segments, "standard");

    // Advance to when "Abro" is in flight & right on beat
    scheduler.update(26.5, "guided");
    scheduler.update(30.05, "guided");

    const targetFirefly = scheduler.getActiveFireflies().find((f) => f.isTarget && f.text === "Abro");
    expect(targetFirefly).toBeDefined();

    const catchRes = scheduler.catchFirefly(targetFirefly!.id, 30.05);
    expect(catchRes.outcome).toBe("caught");
    expect(catchRes.accuracy).toBe("perfect");
    expect(scheduler.stats.caught).toBe(1);
    expect(scheduler.stats.streak).toBe(1);

    // Clicking a decoy does not fail, flags nearest pending cue and resets streak
    const decoy = scheduler.getActiveFireflies().find((f) => !f.isTarget);
    if (decoy) {
      const wrongRes = scheduler.catchFirefly(decoy.id, 30.2);
      expect(wrongRes.outcome).toBe("wrong");
      expect(scheduler.stats.streak).toBe(0);
    }

    // Passing tooLateTime marks remaining cues missed (no game over)
    const { newlyMissed } = scheduler.update(33.5, "guided");
    expect(newlyMissed.some((c) => c.value === "ojos")).toBe(true);
    expect(scheduler.stats.missed).toBeGreaterThanOrEqual(1);

    // Seeking back to 26s respawns missed phrase cleanly for practice
    scheduler.syncToTime(26.0);
    const ojosAfterSeek = scheduler.cues.find((c) => c.value === "ojos")!;
    expect(ojosAfterSeek.status).toBe("pending");
  });
});
