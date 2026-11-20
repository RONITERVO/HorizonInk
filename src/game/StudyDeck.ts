import type { Language, SongProgressRecord, StudyItem, WordCue } from "../types";

const STORAGE_KEY = "horizon-ink-study-deck-v1";
const PROGRESS_KEY = "horizon-ink-progress-v1";

export class StudyDeck {
  private items = new Map<string, StudyItem>();

  constructor() {
    this.load();
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StudyItem[];
      if (Array.isArray(parsed)) {
        let migrated = false;
        for (const item of parsed) {
          if (!item || !item.key) continue;
          // Migrate legacy gather-around id to fuego-que-brilla
          if (item.songId === "gather-around") {
            item.songId = "fuego-que-brilla";
            item.key = item.key.replace(/^gather-around:/, "fuego-que-brilla:");
            migrated = true;
          }
          this.items.set(item.key, item);
        }
        if (migrated) this.save();
      }
    } catch {
      // Ignore corrupt storage
    }
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.list()));
    } catch {
      // Ignore quota errors
    }
  }

  addFromCue(cue: WordCue, songId: string, songTitle: string) {
    const key = `${songId}:${cue.language}:${cue.normalized || cue.value.toLowerCase()}`;
    const existing = this.items.get(key);
    this.items.set(key, {
      key,
      word: cue.value.replace(/[.,!?¿¡…]+$/g, ""),
      language: cue.language,
      primaryLine: cue.primaryLine,
      translationLine: cue.translationLine,
      songId,
      songTitle,
      jumpTime: Math.max(0, cue.start - 4.4),
      missCount: (existing?.missCount ?? 0) + 1,
      lastSeenAt: Date.now(),
    });
    this.save();
  }

  /** Automatically graduate a word from the Study Again deck when caught cleanly in-game. */
  removeIfMatches(songId: string, language: Language, normalizedWord: string): StudyItem | undefined {
    const key = `${songId}:${language}:${normalizedWord}`;
    const existing = this.items.get(key);
    if (existing) {
      this.items.delete(key);
      this.save();
      return existing;
    }
    return undefined;
  }

  markMastered(key: string) {
    if (this.items.delete(key)) {
      this.save();
    }
  }

  clearAll() {
    this.items.clear();
    this.save();
  }

  count(songId?: string): number {
    if (!songId) return this.items.size;
    let total = 0;
    for (const item of this.items.values()) {
      if (item.songId === songId) total += 1;
    }
    return total;
  }

  songIdsWithItems(): Set<string> {
    const ids = new Set<string>();
    for (const item of this.items.values()) {
      ids.add(item.songId);
    }
    return ids;
  }

  list(songId?: string): StudyItem[] {
    const all = [...this.items.values()];
    const filtered = songId ? all.filter((i) => i.songId === songId) : all;
    return filtered.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }
}

export class SongProgressStore {
  private records = new Map<string, SongProgressRecord>();

  constructor() {
    this.load();
  }

  private load() {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, SongProgressRecord>;
      if (obj && typeof obj === "object") {
        for (const [id, rec] of Object.entries(obj)) {
          if (rec && typeof rec.bestAccuracy === "number") {
            const migratedId = id === "gather-around" ? "fuego-que-brilla" : id;
            this.records.set(migratedId, rec);
          }
        }
      }
    } catch {
      // Ignore corrupt progress
    }
  }

  private save() {
    try {
      const out: Record<string, SongProgressRecord> = {};
      for (const [id, rec] of this.records.entries()) {
        out[id] = rec;
      }
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(out));
    } catch {
      // Ignore quota errors
    }
  }

  recordSession(songId: string, accuracyPct: number, bestStreak: number) {
    const prev = this.records.get(songId);
    this.records.set(songId, {
      bestAccuracy: Math.max(prev?.bestAccuracy ?? 0, Math.round(accuracyPct)),
      bestStreak: Math.max(prev?.bestStreak ?? 0, bestStreak),
      plays: (prev?.plays ?? 0) + 1,
      lastPlayedAt: Date.now(),
    });
    this.save();
  }

  get(songId: string): SongProgressRecord | undefined {
    return this.records.get(songId);
  }
}
