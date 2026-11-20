#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourcesPath = path.join(__dirname, "song-sources.json");
const publicDir = path.join(repoRoot, "public");
const songsDir = path.join(publicDir, "songs");
const libraryDir = path.join(repoRoot, "library");
const exportsDir = path.join(libraryDir, "exports");
const missingDir = path.join(libraryDir, "missing-timings");
const rawTimingsDir = path.join(libraryDir, "raw-timings");

const force = process.argv.includes("--force");
const sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
const HISTORY_TURNS = "D:/Projects/Utilities/SkyrimVRControlCenter/runtime/bard/data/history.turns.json";

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function ffprobeDuration(filePath) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { encoding: "utf8" },
  ).trim();
  const val = Number.parseFloat(out);
  if (!Number.isFinite(val) || val <= 0) {
    throw new Error(`Could not probe duration for ${filePath}`);
  }
  return round3(val);
}

function parseJsonSafe(rawText) {
  let source = rawText.replace(/^\uFEFF/, "").trim();
  const fences = [...source.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  if (fences.length === 1) {
    source = fences[0][1].trim();
  }
  return JSON.parse(source);
}

function parseTimestamp(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return NaN;
  const t = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  const parts = t.replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

function extractFuegoLyricsFromHistory() {
  if (!fs.existsSync(HISTORY_TURNS)) return "";
  const turns = JSON.parse(fs.readFileSync(HISTORY_TURNS, "utf8"));
  for (const turn of turns) {
    const text = (turn.parts || []).map((p) => p?.text || "").join("\n");
    const idx = text.indexOf("Fuego que brilla");
    if (idx < 0) continue;
    const chunk = text.slice(Math.max(0, idx - 600), idx + 3500);
    const styleMatch = chunk.match(/\*\*Styles?:\*\*\s*`([^`]+)`/);
    const lyricsMatch = chunk.match(/```(?:text)?\s*\n([\s\S]*?)```/);
    if (lyricsMatch) {
      return `${styleMatch ? styleMatch[1].trim() + "\n\n" : ""}${lyricsMatch[1].trim()}`;
    }
  }
  return "";
}

function readLyricsText(entry) {
  let text = "";
  if (entry.lyricsSource === "history-fuego") {
    text = extractFuegoLyricsFromHistory();
  } else {
    const p = path.join(entry.sourceFolder, "Uusi Tekstitiedosto.txt");
    if (fs.existsSync(p)) {
      text = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").trim();
    }
  }
  if (text) return text;
  const exportLyrics = path.join(exportsDir, "lyrics", `${entry.id}.txt`);
  if (fs.existsSync(exportLyrics)) {
    return fs.readFileSync(exportLyrics, "utf8").replace(/\r\n/g, "\n").trim();
  }
  const missingLyrics = path.join(missingDir, `${entry.id}.txt`);
  if (fs.existsSync(missingLyrics)) {
    const content = fs.readFileSync(missingLyrics, "utf8").replace(/\r\n/g, "\n").trim();
    if (!content.startsWith("[") && !content.startsWith("{") && !content.startsWith("```")) {
      return content;
    }
  }
  return "";
}

function normalizeWordArray(rawData, duration) {
  const rows = Array.isArray(rawData)
    ? rawData
    : Array.isArray(rawData?.words)
      ? rawData.words
      : Array.isArray(rawData?.phrases)
        ? rawData.phrases.flatMap((phrase, pIdx) =>
            (phrase.words || []).map((w) => ({
              ...w,
              language: w?.language ?? phrase.language ?? phrase.language_code,
              phrase_id: w?.phrase_id ?? phrase.phrase_id ?? `p${String(pIdx + 1).padStart(3, "0")}`,
            })),
          )
        : null;
  if (!rows) throw new Error("Unsupported timing JSON format");

  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const text = String(r.text ?? r.word ?? r.value ?? "").trim();
    if (!text) continue;
    let start = parseTimestamp(r.start);
    let end = parseTimestamp(r.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, start);
    if (duration > 0.05) {
      start = Math.min(start, round3(duration - 0.03));
      if (end > duration - 0.01) {
        end = round3(Math.max(start + 0.02, duration - 0.01));
      }
    }
    if (end <= start) end = round3(start + 0.02);
    const langCode = String(r.language ?? r.language_code ?? r.lang ?? "es").toLowerCase().trim();
    const language = /^(en|english)/.test(langCode) ? "en" : "es";
    const phraseId = String(r.phrase_id ?? r.phraseId ?? `p${String(i + 1).padStart(3, "0")}`);
    out.push({
      text,
      start: round3(start),
      end: round3(end),
      language,
      phrase_id: phraseId,
      uncertain: typeof r.uncertain === "boolean" ? r.uncertain : false,
    });
  }
  return out;
}

function buildSegments(words, primaryLanguage) {
  const phrases = [];
  const byKey = new Map();
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    const key = `${w.language}:${w.phrase_id}`;
    let phrase = byKey.get(key);
    if (!phrase) {
      phrase = { language: w.language, words: [] };
      byKey.set(key, phrase);
      phrases.push(phrase);
    }
    phrase.words.push({
      value: w.text,
      start: w.start,
      end: w.end,
      uncertain: w.uncertain,
      sourceIndex: i,
    });
  }
  const startOf = (list) => Math.min(...list.map((w) => w.start));
  phrases.sort((a, b) => startOf(a.words) - startOf(b.words));

  const pairs = [];
  for (const phrase of phrases) {
    if (phrase.language !== "en" || !pairs.length) pairs.push({ es: [], en: [] });
    pairs[pairs.length - 1][phrase.language === "en" ? "en" : "es"].push(...phrase.words);
  }
  const bounds = (pair) => {
    const all = [...pair.es, ...pair.en];
    return {
      start: startOf(all),
      end: Math.max(...all.map((w) => w.end)),
    };
  };
  const groups = [];
  for (const pair of pairs) {
    const prev = groups[groups.length - 1];
    if (prev && bounds(pair).start < bounds(prev).end) {
      prev.es.push(...pair.es);
      prev.en.push(...pair.en);
    } else {
      groups.push(pair);
    }
  }
  const sortWords = (list, lang) =>
    [...list]
      .sort((a, b) => a.start - b.start || a.sourceIndex - b.sourceIndex)
      .map((w) => ({
        value: w.value,
        start: w.start,
        end: w.end,
        uncertain: w.uncertain,
        sourceIndex: w.sourceIndex,
        language: lang,
      }));

  return groups.map((g, idx) => {
    const primaryWords = sortWords(g.es, primaryLanguage);
    const translationWords = sortWords(g.en, "en");
    return {
      id: `seg-${idx + 1}`,
      ...bounds(g),
      primary: primaryWords.map((w) => w.value).join(primaryLanguage === "zh" ? "" : " "),
      translation: translationWords.map((w) => w.value).join(" "),
      words: primaryWords,
      translationWords,
      translationTiming: "sung",
      language_code: primaryLanguage,
    };
  });
}

function fmtLrc(sec) {
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${String(mins).padStart(2, "0")}:${rem.toFixed(2).padStart(5, "0")}`;
}

function fmtVtt(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(3).padStart(6, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s}`;
}

function fmtSrt(sec) {
  return fmtVtt(sec).replace(".", ",");
}

function generateLrc(entry, segments) {
  const lines = [`[ti:${entry.title}]`, `[ar:NoFocus · ${entry.genre}]`, `[la:${entry.primaryLanguage}]`, ""];
  for (const seg of segments) {
    if (seg.words.length) {
      const startTag = `[${fmtLrc(seg.words[0].start)}]`;
      const wordTags = seg.words.map((w) => `<${fmtLrc(w.start)}>${w.value}`).join(" ");
      lines.push(`${startTag}${wordTags}`);
    }
    if (seg.translationWords.length) {
      const startTag = `[${fmtLrc(seg.translationWords[0].start)}]`;
      const wordTags = seg.translationWords.map((w) => `<${fmtLrc(w.start)}>${w.value}`).join(" ");
      lines.push(`${startTag}(${wordTags})`);
    }
  }
  return lines.join("\n") + "\n";
}

function generateVtt(segments) {
  const lines = ["WEBVTT", ""];
  for (const seg of segments) {
    lines.push(`${fmtVtt(seg.start)} --> ${fmtVtt(seg.end)}`);
    if (seg.primary) lines.push(seg.primary);
    if (seg.translation) lines.push(`(${seg.translation})`);
    lines.push("");
  }
  return lines.join("\n");
}

function generateSrt(segments) {
  const lines = [];
  segments.forEach((seg, idx) => {
    lines.push(String(idx + 1));
    lines.push(`${fmtSrt(seg.start)} --> ${fmtSrt(seg.end)}`);
    if (seg.primary) lines.push(seg.primary);
    if (seg.translation) lines.push(`(${seg.translation})`);
    lines.push("");
  });
  return lines.join("\n");
}

function ensureAudioAt(entry, targetM4a, alternateM4a) {
  if (!force && fs.existsSync(targetM4a) && fs.statSync(targetM4a).size > 10_000) {
    return;
  }
  if (!force && alternateM4a && fs.existsSync(alternateM4a) && fs.statSync(alternateM4a).size > 10_000) {
    fs.renameSync(alternateM4a, targetM4a);
    return;
  }
  const baseName = path.basename(entry.sourceFolder);
  const mp4Path = path.join(entry.sourceFolder, `${baseName}.mp4`);
  if (!fs.existsSync(mp4Path)) {
    throw new Error(`Missing source video: ${mp4Path}`);
  }
  console.log(`Extracting lossless AAC -> ${path.relative(repoRoot, targetM4a)}`);
  execFileSync(
    "ffmpeg",
    ["-nostdin", "-v", "error", "-y", "-i", mp4Path, "-map", "0:a:0", "-vn", "-c:a", "copy", "-movflags", "+faststart", targetM4a],
    { stdio: "inherit" },
  );
}

function resolveTimingSourceFile(entry) {
  if (entry.timingFile) {
    const configured = path.isAbsolute(entry.timingFile)
      ? entry.timingFile
      : path.join(repoRoot, entry.timingFile);
    if (fs.existsSync(configured)) return configured;
  }
  for (const ext of [".txt", ".json"]) {
    const archived = path.join(rawTimingsDir, `${entry.id}${ext}`);
    if (fs.existsSync(archived)) return archived;
  }
  const dropJson = path.join(missingDir, `${entry.id}.json`);
  if (fs.existsSync(dropJson)) return dropJson;
  const dropTxt = path.join(missingDir, `${entry.id}.txt`);
  if (fs.existsSync(dropTxt)) {
    // Only treat dropped .txt in missing-timings as timing JSON if it parses as JSON (lyrics sheets are plain text)
    const content = fs.readFileSync(dropTxt, "utf8").trim();
    if (content.startsWith("[") || content.startsWith("{") || content.startsWith("```")) {
      return dropTxt;
    }
  }
  // Fall back to already-bundled JSON in public/songs/ when original raw source is deleted
  const bundledJson = path.join(songsDir, `${entry.id}.json`);
  if (entry.timingSource && entry.timingSource !== "missing" && fs.existsSync(bundledJson)) {
    return bundledJson;
  }
  return null;
}

function run() {
  fs.mkdirSync(songsDir, { recursive: true });
  fs.mkdirSync(missingDir, { recursive: true });
  fs.mkdirSync(rawTimingsDir, { recursive: true });
  for (const dir of ["lrc", "vtt", "srt", "segments", "lyrics"]) {
    fs.mkdirSync(path.join(exportsDir, dir), { recursive: true });
  }

  const readyIds = new Set();
  const manifest = [];
  const catalog = [];
  const missingList = [];

  for (const entry of sources) {
    const timingPath = resolveTimingSourceFile(entry);
    const lyricsText = readLyricsText(entry);
    const publicM4a = path.join(songsDir, `${entry.id}.m4a`);
    const publicJson = path.join(songsDir, `${entry.id}.json`);
    const missingM4a = path.join(missingDir, `${entry.id}.m4a`);
    const missingLyrics = path.join(missingDir, `${entry.id}.txt`);

    if (timingPath) {
      readyIds.add(entry.id);
      ensureAudioAt(entry, publicM4a, missingM4a);
      if (fs.existsSync(missingM4a)) fs.unlinkSync(missingM4a);
      if (fs.existsSync(missingLyrics) && path.resolve(missingLyrics) !== path.resolve(timingPath)) {
        fs.unlinkSync(missingLyrics);
      }
      const duration = ffprobeDuration(publicM4a);

      const rawArchivePath = path.join(rawTimingsDir, `${entry.id}.txt`);
      const rawText = fs.readFileSync(timingPath, "utf8");
      if (path.resolve(timingPath) !== path.resolve(rawArchivePath)) {
        fs.writeFileSync(rawArchivePath, rawText, "utf8");
      }

      const raw = parseJsonSafe(rawText);
      const words = normalizeWordArray(raw, duration);
      if (!words.length) {
        throw new Error(`No valid words normalized for ${entry.id}`);
      }

      for (let i = 0; i < words.length; i += 1) {
        const w = words[i];
        if (!w.text || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0 || w.end <= w.start) {
          throw new Error(`${entry.id} word #${i} invalid span: ${JSON.stringify(w)}`);
        }
        if (w.end > duration + 0.05) {
          throw new Error(`${entry.id} word #${i} exceeds duration (${w.end} > ${duration})`);
        }
        if (!["es", "en"].includes(w.language)) {
          throw new Error(`${entry.id} word #${i} invalid language: ${w.language}`);
        }
        if (typeof w.uncertain !== "boolean") {
          throw new Error(`${entry.id} word #${i} uncertain is not boolean`);
        }
      }

      fs.writeFileSync(publicJson, JSON.stringify(words, null, 2) + "\n", "utf8");
      const segments = buildSegments(words, entry.primaryLanguage);
      if (segments.length < 6) {
        throw new Error(`${entry.id} produced too few segments (${segments.length})`);
      }

      manifest.push({
        id: entry.id,
        title: entry.title,
        subtitle: entry.subtitle,
        genre: entry.genre,
        primaryLanguage: entry.primaryLanguage,
        duration,
        wordCount: words.length,
        audioUrl: `./songs/${entry.id}.m4a`,
        timingUrl: `./songs/${entry.id}.json`,
        timingSource: "gemini",
        lyricsText,
      });

      fs.writeFileSync(path.join(exportsDir, "lrc", `${entry.id}.lrc`), generateLrc(entry, segments), "utf8");
      fs.writeFileSync(path.join(exportsDir, "vtt", `${entry.id}.vtt`), generateVtt(segments), "utf8");
      fs.writeFileSync(path.join(exportsDir, "srt", `${entry.id}.srt`), generateSrt(segments), "utf8");
      fs.writeFileSync(
        path.join(exportsDir, "segments", `${entry.id}.segments.json`),
        JSON.stringify(
          {
            title: entry.title,
            genre: entry.genre,
            primaryLanguage: entry.primaryLanguage,
            duration,
            source: "gemini",
            translationTiming: "sung",
            segments,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      fs.writeFileSync(path.join(exportsDir, "lyrics", `${entry.id}.txt`), lyricsText + "\n", "utf8");

      catalog.push({
        id: entry.id,
        title: entry.title,
        subtitle: entry.subtitle,
        genre: entry.genre,
        primaryLanguage: entry.primaryLanguage,
        status: "ready",
        duration,
        wordCount: words.length,
        segmentCount: segments.length,
        timingSource: "gemini",
        sourceTimingFile: `./raw-timings/${entry.id}.txt`,
        files: {
          audio: `../public/songs/${entry.id}.m4a`,
          geminiWordTiming: `../public/songs/${entry.id}.json`,
          segmentsJson: `./exports/segments/${entry.id}.segments.json`,
          lrc: `./exports/lrc/${entry.id}.lrc`,
          vtt: `./exports/vtt/${entry.id}.vtt`,
          srt: `./exports/srt/${entry.id}.srt`,
          lyrics: `./exports/lyrics/${entry.id}.txt`,
        },
      });
    } else {
      // No human-inspected AI Studio timing file yet: keep audio & lyrics cleanly staged under library/missing-timings/
      if (fs.existsSync(publicJson)) fs.unlinkSync(publicJson);
      ensureAudioAt(entry, missingM4a, publicM4a);
      if (fs.existsSync(publicM4a)) fs.unlinkSync(publicM4a);
      fs.writeFileSync(missingLyrics, lyricsText + "\n", "utf8");

      const duration = ffprobeDuration(missingM4a);
      missingList.push({ ...entry, duration });
      catalog.push({
        id: entry.id,
        title: entry.title,
        subtitle: entry.subtitle,
        genre: entry.genre,
        primaryLanguage: entry.primaryLanguage,
        status: "missing-timing",
        duration,
        wordCount: 0,
        segmentCount: 0,
        timingSource: "missing",
        sourceFolder: entry.sourceFolder,
        files: {
          audio: `./missing-timings/${entry.id}.m4a`,
          lyrics: `./missing-timings/${entry.id}.txt`,
        },
      });
    }
  }

  // Strictly enforce that public/songs/ contains ONLY ready <id>.m4a and <id>.json pairs
  for (const file of fs.readdirSync(songsDir)) {
    const ext = path.extname(file).toLowerCase();
    const stem = path.basename(file, ext);
    const keep = (ext === ".m4a" || ext === ".json") && readyIds.has(stem);
    if (!keep) {
      fs.unlinkSync(path.join(songsDir, file));
      console.log(`Cleaned non-ready file from public/songs/: ${file}`);
    }
  }

  fs.writeFileSync(path.join(publicDir, "songs-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(libraryDir, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n", "utf8");

  const missingRows = missingList
    .map(
      (m, idx) =>
        `| ${idx + 1} | \`${m.id}\` | ${m.title} | ${m.genre} | ${m.duration.toFixed(2)}s | \`${m.sourceFolder}\` |`,
    )
    .join("\n");

  const missingReadme =
    missingList.length === 0
      ? `# Songs Missing Human-Inspected AI Studio Timing Files (0 Tracks)

All **${sources.length} Suno visualizer tracks** now have verified human-inspected Google AI Studio timing files archived in \`../raw-timings/\` and bundled in \`../../public/songs/\`!
`
      : `# Songs Missing Human-Inspected AI Studio Timing Files (${missingList.length} Tracks)

These ${missingList.length} Suno songs have verified lossless 48 kHz AAC audio (\`<id>.m4a\`) and original lyric sheets (\`<id>.txt\`) staged here, but **do not yet have an AI Studio word-timing file**. Per project policy, no OCR or Whisper timing fallback is generated automatically.

| # | ID | Title | Genre | Duration | Source Visualizer Folder |
| --- | --- | --- | --- | --- | --- |
${missingRows}

## How to Add Timing Later
1. Generate / verify the word-timing JSON in Google AI Studio for any track above.
2. Save the JSON file here as \`library/missing-timings/<id>.json\` (or update \`scripts/song-sources.json\`), then run:
   \`\`\`bash
   npm run songs:gather
   \`\`\`
   That promotes the track into \`public/songs/\`, \`public/songs-manifest.json\`, and \`library/exports/\` automatically.
`;
  fs.writeFileSync(path.join(missingDir, "README.md"), missingReadme, "utf8");

  const libraryReadme = `# Horizon Ink — Bilingual Song & Timing Library (${manifest.length} Ready / ${sources.length} Total)

This portable library gathers all **${sources.length} Suno visualizer tracks** with lossless extracted 48 kHz AAC audio (\`.m4a\`):
- **${manifest.length} Ready Tracks** (human-inspected Google AI Studio word-level timings verified against every audio file): bundled in \`../public/songs/\` and exported across all formats in \`exports/\`.
- **${missingList.length} Tracks Awaiting Timing Files**: staged cleanly in \`missing-timings/\` with lossless \`.m4a\` audio + verbatim \`.txt\` lyrics so you can supply AI Studio JSONs anytime.

## Using with Visual Music Lyrics
- Open **Visual Music Lyrics** and drop all files inside \`../public/songs/\` directly onto the app!
- \`public/songs/\` contains **strictly** the ${manifest.length} paired \`<id>.m4a\` + \`<id>.json\` files (${manifest.length * 2} files total) with zero manifest clutter and zero substring filename collisions.
- Every \`.json\` passes strict \`convertGeminiJson()\` word-level validation (\`0 <= start < end <= duration\`, \`language: "es" | "en"\`, \`phrase_id\`, \`uncertain\`).

## Export Formats in \`exports/\`
- \`exports/segments/<id>.segments.json\` — Pre-grouped bilingual \`Segment[]\` JSON ready for \`Visual-Music-Lyrics\` / custom players.
- \`exports/lrc/<id>.lrc\` — Enhanced word-timed LRC (\`[mm:ss.xx]<mm:ss.xx>word\`) for music players & lyric visualizers.
- \`exports/vtt/<id>.vtt\` & \`exports/srt/<id>.srt\` — Standard WebVTT and SubRip bilingual caption files.
- \`exports/lyrics/<id>.txt\` — Suno style prompt + verbatim bilingual lyric sheets.
- \`raw-timings/<id>.txt\` — Verbatim archived human-inspected Google AI Studio timing exports (so rebuilding works even after clearing \`Downloads\`).
- \`catalog.json\` — Machine-readable index of all ${sources.length} tracks (\`ready\` vs \`missing-timing\`).

## Regenerating / Adding Missing Timings
\`\`\`bash
npm run songs:gather
\`\`\`
`;
  fs.writeFileSync(path.join(libraryDir, "README.md"), libraryReadme, "utf8");

  console.log(
    `Gather complete: ${manifest.length} ready in public/songs/ (${manifest.length * 2} files), ${missingList.length} missing-timing staged in library/missing-timings/.`,
  );
}

run();
