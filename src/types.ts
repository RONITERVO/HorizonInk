export type Language = "es" | "en";

export type PaceMode = "relaxed" | "standard" | "brisk";
export type AssistMode = "guided" | "immersion" | "zen";

export interface MusicLyricWord {
  value: string;
  start: number;
  end: number;
  uncertain?: boolean;
  sourceIndex?: number;
  language?: Language;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  primary: string;
  translation: string;
  words: MusicLyricWord[];
  translationWords: MusicLyricWord[];
  translationTiming: "sung";
  language_code: string;
}

export interface SongManifestEntry {
  id: string;
  title: string;
  subtitle: string;
  duration: number;
  wordCount: number;
  audioUrl: string;
  timingUrl: string;
  lyricsText?: string;
}

export type WordCatchStatus = "pending" | "caught" | "missed" | "auto";

export interface WordCue {
  id: string;
  index: number;
  value: string;
  normalized: string;
  language: Language;
  segmentId: string;
  primaryLine: string;
  translationLine: string;
  start: number;
  end: number;
  spawnTime: number;
  idealTime: number;
  tooLateTime: number;
  status: WordCatchStatus;
  caughtAt?: number;
  accuracy?: "early" | "perfect" | "late";
}

export interface FireflyCandidate {
  id: string;
  text: string;
  language: Language;
  isTarget: boolean;
  targetCueId?: string;
  spawnTime: number;
  idealTime: number;
  tooLateTime: number;
  // 3D trajectory parameters in world space
  originX: number;
  originY: number;
  originZ: number;
  catchX: number;
  catchY: number;
  catchZ: number;
  swayFreq: number;
  swayPhase: number;
  swayAmpX: number;
  swayAmpY: number;
  state: "flying" | "caught" | "missed" | "dismissed";
  stateChangedAt: number;
}

export interface StudyItem {
  key: string;
  word: string;
  language: Language;
  primaryLine: string;
  translationLine: string;
  songId: string;
  songTitle: string;
  jumpTime: number;
  missCount: number;
  lastSeenAt: number;
}

export interface GameStats {
  caught: number;
  perfect: number;
  missed: number;
  wrongClicks: number;
  streak: number;
  bestStreak: number;
  totalTargets: number;
}

