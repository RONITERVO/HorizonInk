import type { Language, MusicLyricWord, PrimaryLanguage, Segment, SongManifestEntry } from "../types";

type Row = Record<string, unknown>;

interface ParsedWord extends MusicLyricWord {
  uncertain: boolean;
  sourceIndex: number;
  language?: Language;
  phraseId?: string;
}

interface Phrase {
  language: Language;
  words: ParsedWord[];
}

interface Pair {
  primary: ParsedWord[];
  en: ParsedWord[];
}

export function containsCjk(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
}

export function makeWordKey(word: Pick<MusicLyricWord, "start" | "sourceIndex" | "value">): string {
  return `${word.start.toFixed(2)}:${word.sourceIndex ?? 0}:${word.value}`;
}

export function readGeminiJson(text: string): unknown {
  let source = text.replace(/^\uFEFF/, "").trim();
  const fences = [...source.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  if (fences.length > 1) {
    throw new Error("Keep only the final Gemini JSON response, not several revisions.");
  }
  if (fences.length === 1) {
    source = fences[0][1].trim();
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("Could not read Gemini JSON. Select a valid timed-word JSON file.");
  }
}

function wordRows(data: unknown): Row[] | null {
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.words)) return obj.words as Row[];
    if (Array.isArray(obj.phrases)) {
      return (obj.phrases as Row[]).flatMap((phrase, index) => {
        if (!phrase || !Array.isArray(phrase.words) || !phrase.words.length) {
          throw new Error(`Phrase ${index + 1} needs word-level timings.`);
        }
        return (phrase.words as Row[]).map((word) => ({
          ...word,
          language: word?.language ?? phrase.language ?? phrase.language_code,
          phrase_id: `phrase-${index}`,
        }));
      });
    }
  }
  return null;
}

function timestamp(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return NaN;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (!/^(?:\d+:)?\d{1,2}:[0-5]\d(?:[.,]\d+)?$/.test(text)) return NaN;
  const parts = text.replace(",", ".").split(":").map(Number);
  if (parts.length === 3 && parts[1] >= 60) return NaN;
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

function parseLanguage(value: unknown): Language | undefined {
  if (value == null || value === "") return undefined;
  const code = String(value).toLowerCase().trim();
  if (/^(es(?:-.*)?|spanish|español)$/.test(code)) return "es";
  if (/^(zh(?:-.*)?|cmn(?:-.*)?|chinese|mandarin|中文)$/.test(code)) return "zh";
  if (/^(en(?:-.*)?|english|inglés)$/.test(code)) return "en";
  return undefined;
}

export function normalizeWordKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function readGuide(text: string, defaultPrimary: PrimaryLanguage): Map<string, Set<Language>> {
  const guide = new Map<string, Set<Language>>();
  const add = (lineText: string, lang: Language) => {
    const key = normalizeWordKey(lineText);
    if (!key) return;
    if (!guide.has(key)) guide.set(key, new Set());
    guide.get(key)!.add(lang);
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const explicit = line.match(/^\[(es|zh|en)\]\s*(.+)$/i);
    if (explicit) {
      add(explicit[2], explicit[1].toLowerCase() as Language);
      continue;
    }
    if (!line || line.startsWith("[")) continue;
    for (const match of line.matchAll(/\(([^)]+)\)/g)) add(match[1], "en");
    const lead = line.replace(/\([^)]*\)/g, "").trim();
    if (lead) {
      add(lead, containsCjk(lead) ? "zh" : defaultPrimary);
    }
  }
  return guide;
}

export function convertGeminiJson(
  text: string,
  options: { title?: string; lyrics?: string; duration?: number; primaryLanguage?: PrimaryLanguage } = {},
): { title: string; primaryLanguage: PrimaryLanguage; segments: Segment[]; allWords: ParsedWord[] } {
  const data = readGeminiJson(text);
  const rows = wordRows(data);
  if (!rows?.length) {
    throw new Error("Expected an array of timed words, { words: [...] }, or { phrases: [...] }.");
  }

  const rawWords: ParsedWord[] = [];
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Entry ${index + 1} is not a timed word.`);
    }
    const value = String(row.text ?? row.word ?? row.value ?? "").trim();
    const start = timestamp(row.start);
    const end = timestamp(row.end);
    if (!value || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      continue;
    }
    const lang = parseLanguage(row.language ?? row.language_code ?? row.lang);
    const phrase = row.phrase_id ?? row.phraseId;
    const word: ParsedWord = {
      value,
      start,
      end,
      uncertain: typeof row.uncertain === "boolean" ? row.uncertain : false,
      sourceIndex: index,
      ...(lang ? { language: lang } : {}),
      ...(phrase != null ? { phraseId: String(phrase) } : {}),
    };
    if (normalizeWordKey(value)) rawWords.push(word);
  }

  if (!rawWords.length) throw new Error("The JSON contains no valid lyric words.");

  // Auto-detect CJK primary language (e.g. Moving Ink & Bending Bamboo use "es" on disk
  // for Visual-Music-Lyrics compatibility, while singing Chinese characters).
  const detectedPrimary: PrimaryLanguage =
    options.primaryLanguage ??
    (rawWords.some((w) => w.language !== "en" && (w.language === "zh" || containsCjk(w.value))) ? "zh" : "es");

  const words: ParsedWord[] = rawWords.map((w) => {
    if (w.language === "en") return w;
    if (detectedPrimary === "zh" || containsCjk(w.value)) {
      return { ...w, language: "zh" };
    }
    return w.language ? w : { ...w, language: detectedPrimary };
  });

  const guide = readGuide(options.lyrics || "", detectedPrimary);
  const longestGuideKey = Math.max(0, ...[...guide.keys()].map((k) => k.length));
  const phrases: Phrase[] = [];
  const explicitPhrases = new Map<string, Phrase>();

  for (let index = 0; index < words.length; ) {
    const word = words[index];
    if (word.language && word.phraseId !== undefined) {
      const key = `${word.language}:${word.phraseId}`;
      let phrase = explicitPhrases.get(key);
      if (!phrase) {
        phrase = { language: word.language, words: [] };
        explicitPhrases.set(key, phrase);
        phrases.push(phrase);
      }
      phrase.words.push(word);
      index++;
      continue;
    }

    let match: { length: number; language: Language } | undefined;
    let key = "";
    for (let end = index; end < words.length; end++) {
      const candidate = words[end];
      if (candidate.phraseId !== undefined && candidate.language) break;
      key += normalizeWordKey(candidate.value);
      if (key.length > longestGuideKey) break;
      const labels = guide.get(key);
      if (!labels) continue;
      const compatible = [...labels].filter((lang) =>
        words.slice(index, end + 1).every((w) => !w.language || w.language === lang),
      );
      if (compatible.length === 1) match = { length: end - index + 1, language: compatible[0] };
    }

    if (match) {
      phrases.push({ language: match.language, words: words.slice(index, index + match.length) });
      index += match.length;
      continue;
    }

    const lang: Language = word.language ?? detectedPrimary;
    const phrase: Phrase = { language: lang, words: [word] };
    index++;
    while (index < words.length && phrase.words.length < 12) {
      const next = words[index];
      const previous = phrase.words[phrase.words.length - 1];
      if (
        (next.language ?? lang) !== phrase.language ||
        next.phraseId !== undefined ||
        next.start - previous.end > 0.8 ||
        /[.!?]$/.test(previous.value)
      ) {
        break;
      }
      phrase.words.push(next);
      index++;
    }
    phrases.push(phrase);
  }

  const startOf = (list: ParsedWord[]) => Math.min(...list.map((w) => w.start));
  phrases.sort((a, b) => startOf(a.words) - startOf(b.words));

  // Native language (es or zh) leads each bilingual pair; English echo follows.
  const pairs: Pair[] = [];
  for (const phrase of phrases) {
    if (phrase.language !== "en" || !pairs.length) {
      pairs.push({ primary: [], en: [] });
    }
    if (phrase.language === "en") {
      pairs[pairs.length - 1].en.push(...phrase.words);
    } else {
      pairs[pairs.length - 1].primary.push(...phrase.words);
    }
  }

  const bounds = (pair: Pair) => {
    const all = [...pair.primary, ...pair.en];
    return {
      start: startOf(all),
      end: Math.max(...all.map((w) => w.end)),
    };
  };

  const groups: Pair[] = [];
  for (const pair of pairs) {
    const previous = groups[groups.length - 1];
    if (previous && bounds(pair).start < bounds(previous).end) {
      previous.primary.push(...pair.primary);
      previous.en.push(...pair.en);
    } else {
      groups.push(pair);
    }
  }

  const outputWords = (list: ParsedWord[], lang: Language): MusicLyricWord[] =>
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

  const segments: Segment[] = groups.map((group, index) => {
    const primaryWords = outputWords(group.primary, detectedPrimary);
    const translationWords = outputWords(group.en, "en");
    return {
      id: `seg-${index + 1}`,
      ...bounds(group),
      primary: primaryWords.map((w) => w.value).join(detectedPrimary === "zh" ? "" : " "),
      translation: translationWords.map((w) => w.value).join(" "),
      words: primaryWords,
      translationWords,
      translationTiming: "sung",
      language_code: detectedPrimary,
    };
  });

  const dataTitle =
    data && typeof data === "object" && "title" in data && typeof (data as Row).title === "string"
      ? String((data as Row).title)
      : undefined;

  return {
    title: options.title || dataTitle || "Untitled Song",
    primaryLanguage: detectedPrimary,
    segments,
    allWords: words,
  };
}

export function wordProgress(start: number, end: number, currentTime: number): number {
  if (currentTime <= start) return 0;
  if (currentTime >= end || end <= start) return 1;
  return (currentTime - start) / (end - start);
}

export function displaySegmentAt(segments: Segment[], seconds: number): Segment | undefined {
  const active = segments.find(
    (segment, index) =>
      seconds >= segment.start &&
      (seconds < segment.end || (index === segments.length - 1 && seconds <= segment.end)),
  );
  if (active) return active;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (seconds > segment.end && seconds <= segment.end + 0.42) return segment;
  }
  return undefined;
}

const TRIM_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const STAGE_DIR_RE = /^(fade\s+out|heavy\s+beat|beat\s+drop|instrumental|solo|end|outro|intro)\b/i;

function normalizeLyricsBody(lyricsText: string | undefined): string[] {
  if (!lyricsText) return [];
  return lyricsText.split(/\r?\n/).slice(1);
}

function lyricsBodySignature(lyricsText: string | undefined): string {
  return normalizeLyricsBody(lyricsText).join("\n").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Extracts clean deduplicated vocabulary per language strictly from OTHER songs in the library
 * (excluding the active song and any sibling remix sharing identical lyrics).
 */
export function extractOtherSongVocabulary(
  manifest: Pick<SongManifestEntry, "id" | "primaryLanguage" | "lyricsText">[],
  activeSongId?: string,
): { es: string[]; en: string[]; zh: string[] } {
  const activeEntry = activeSongId ? manifest.find((s) => s.id === activeSongId) : undefined;
  const activeSignature = activeEntry ? lyricsBodySignature(activeEntry.lyricsText) : "";

  const seen: Record<Language, Set<string>> = {
    es: new Set(),
    zh: new Set(),
    en: new Set(),
  };
  const out: { es: string[]; en: string[]; zh: string[] } = {
    es: [],
    en: [],
    zh: [],
  };

  const pushToken = (lang: Language, rawToken: string) => {
    const clean = rawToken.replace(TRIM_PUNCT, "").trim();
    if (!clean || /^\d+$/.test(clean)) return;
    const key = normalizeWordKey(clean);
    if (!key || seen[lang].has(key)) return;
    seen[lang].add(key);
    out[lang].push(clean);
  };

  for (const song of manifest) {
    if (activeSongId && song.id === activeSongId) continue;
    const sig = lyricsBodySignature(song.lyricsText);
    if (activeSignature && sig === activeSignature) continue;

    for (const rawLine of normalizeLyricsBody(song.lyricsText)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("[") || /^[#*>]/u.test(line)) continue;

      for (const m of line.matchAll(/\(([^)]+)\)/g)) {
        const inner = m[1].replace(/^echo\s*:\s*/i, "").trim();
        if (!inner || STAGE_DIR_RE.test(inner)) continue;
        for (const tok of inner.split(/\s+/)) {
          pushToken("en", tok);
        }
      }

      const lead = line.replace(/\([^)]*\)/g, "").trim();
      if (!lead) continue;
      if (song.primaryLanguage === "zh" || containsCjk(lead)) {
        for (const ch of lead.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []) {
          pushToken("zh", ch);
        }
      } else {
        for (const tok of lead.split(/\s+/)) {
          pushToken("es", tok);
        }
      }
    }
  }

  return out;
}
