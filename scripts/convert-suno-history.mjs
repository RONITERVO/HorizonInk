#!/usr/bin/env node
/**
 * Converts Gemini-format `history.turns.json` (used by SkyrimVRControlCenter bard)
 * into Antigravity-ready formats:
 *   1. `prompts/suno-history.acp.json`  - Full lossless turns in { role: "user" | "assistant", content }[]
 *   2. `prompts/suno-style-bible.md`    - Compact (<40 KB) single-read style & exemplar guide for `agy -p`
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const DEFAULT_SOURCE = "D:/Projects/Utilities/SkyrimVRControlCenter/runtime/bard/data/history.turns.json";
const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SOURCE;
const outDir = path.join(repoRoot, "prompts");

if (!fs.existsSync(sourcePath)) {
  console.error(`Source file not found: ${sourcePath}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
if (!Array.isArray(raw)) {
  console.error("Expected an array of Gemini turns.");
  process.exit(1);
}

// 1. Lossless OpenAI / Antigravity ACP turn format
const acpTurns = raw.map((turn, idx) => {
  const role = turn.role === "user" ? "user" : "assistant";
  const content = (turn.parts ?? [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return { index: idx, role, content };
});

fs.mkdirSync(outDir, { recursive: true });
const acpOutPath = path.join(outDir, "suno-history.acp.json");
fs.writeFileSync(acpOutPath, JSON.stringify(acpTurns, null, 2) + "\n", "utf8");

// 2. Parse all tracks (title, concept, style, lyrics) across model turns
const tracks = [];
for (const turn of acpTurns) {
  if (turn.role !== "assistant") continue;

  // Turn 1 has a slightly different single-track heading structure
  if (turn.index === 1) {
    const styleMatch = turn.content.match(/### 1\. Paste this into the "Styles" Box:\s*\n>\s*([^\n]+)/);
    const lyricsMatch = turn.content.match(/### 2\. Paste this into the "Lyrics" Box:[\s\S]*?```text\s*\n([\s\S]*?)```/);
    if (styleMatch && lyricsMatch) {
      tracks.push({
        turn: turn.index,
        title: "Latin Crossover Club Demo",
        concept: "Female-led Latin crossover pop/club hit with Spanish lead and English backing echoes.",
        style: styleMatch[1].trim(),
        lyrics: lyricsMatch[1].trim(),
      });
    }
    continue;
  }

  const sections = turn.content.split(/\n(?=### (?:Track \d+: )?)/);
  for (const section of sections) {
    const headingMatch = section.match(/^### (?:Track \d+: )?([^\n]+)/);
    if (!headingMatch) continue;
    const title = headingMatch[1].trim();
    const conceptMatch = section.match(/\*\*Concept:\*\*\s*([^\n]+)/);
    const styleMatch = section.match(/\*\*Styles?:\*\*\s*`([^`]+)`/);
    const lyricsMatch = section.match(/```(?:text)?\s*\n([\s\S]*?)```/);
    if (!styleMatch || !lyricsMatch) continue;
    tracks.push({
      turn: turn.index,
      title,
      concept: conceptMatch ? conceptMatch[1].trim() : "",
      style: styleMatch[1].trim(),
      lyrics: lyricsMatch[1].trim(),
    });
  }
}

// Keep a balanced exemplar subset for the single-read Style Bible (< 800 lines & < 46 KB)
const exemplarIndices = new Set([0, 11, 21, 31, 61, 88]);
const exemplars = tracks.filter((_, i) => exemplarIndices.has(i));
if (exemplars.length === 0 && tracks.length > 0) {
  exemplars.push(...tracks.slice(0, 6));
}

const bibleLines = [
  "# Horizon Ink — Suno Bilingual Songwriting Style Bible",
  "",
  `Converted from \`${path.basename(sourcePath)}\` (${acpTurns.length} turns, ${tracks.length} extracted tracks).`,
  "Sized for single-call `read_file` / `agy -p` context loading (< 46 KB limit).",
  "",
  "## Core Creative Formula",
  "1. **Subliminal Bilingual Bounce**: Lead vocals sing the target language (e.g. Spanish) clearly line by line; the English translation / echo follows immediately in `(parentheses)` so Suno renders English as stylized backing vocals, whispers, ad-libs, or call-and-response echoes.",
  "2. **3+ Minute / Full-Length Pacing**: Use extended song structures so Suno generates full, rich arrangements instead of rushing: `[Intro]`, `[Verse 1]`, `[Pre-Chorus]`, `[Chorus]`, `[Drop 1 / Instrumental Solo]`, `[Verse 2]`, `[Pre-Chorus]`, `[Chorus]`, `[Extended Drop 2]`, `[Bridge]`, `[Outro]`.",
  "3. **Section & Direction Tags**: Put all non-sung production, mood, vocal delivery, and instrumental cues inside `[Square Brackets]`, never in `(parentheses)` (which Suno may sing).",
  "4. **Suno Style String (`style` / `tags`)**: Comma-separated production tags covering genre/subgenre, BPM/groove, signature solo instrument (e.g. solo violin, acoustic guitar, 808s, synthwave bass), vocal gender & delivery, and atmosphere.",
  "5. **Horizon Ink / Lexicommons Vocabulary Integration**: When supplied with `learned_words` and `target_words`, weave `learned_words` naturally as familiar anchors and spotlight `target_words` in memorable, singable hooks with clear `(English echo)` pairs.",
  "",
  `## Extracted Style Catalog (${tracks.length} Reference Tracks)`,
  "",
  ...tracks.map((t, i) => `- **${i + 1}. ${t.title}** *(turn ${t.turn})*: \`${t.style}\``),
  "",
  "## Verbatim Exemplars (Format & Pacing Reference)",
  "",
  ...exemplars.flatMap((t) => [
    `### ${t.title}`,
    ...(t.concept ? [`- **Concept**: ${t.concept}`] : []),
    `- **Styles**: \`${t.style}\``,
    "```text",
    t.lyrics,
    "```",
    "",
  ]),
];

const bibleText = bibleLines.join("\n");
const bibleOutPath = path.join(outDir, "suno-style-bible.md");
fs.writeFileSync(bibleOutPath, bibleText, "utf8");

console.log(
  JSON.stringify(
    {
      source: sourcePath,
      turns: acpTurns.length,
      extractedTracks: tracks.length,
      outputs: {
        acpJson: { path: acpOutPath, bytes: fs.statSync(acpOutPath).size },
        styleBibleMd: {
          path: bibleOutPath,
          bytes: fs.statSync(bibleOutPath).size,
          lines: bibleText.split("\n").length,
        },
      },
    },
    null,
    2,
  ),
);
