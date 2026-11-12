import type { StudyItem, WordCue } from "../types";

const STORAGE_KEY = "horizon-ink-study-deck-v1";

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
        for (const item of parsed) {
          if (item && item.key) this.items.set(item.key, item);
        }
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

  markMastered(key: string) {
    if (this.items.delete(key)) {
      this.save();
    }
  }

  clearAll() {
    this.items.clear();
    this.save();
  }

  count(): number {
    return this.items.size;
  }

  list(songId?: string): StudyItem[] {
    const all = [...this.items.values()];
    const filtered = songId ? all.filter((i) => i.songId === songId) : all;
    return filtered.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }
}

