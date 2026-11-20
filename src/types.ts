export type PrimaryLanguage = "es" | "zh";
export type Language = PrimaryLanguage | "en";

export type PaceMode = "relaxed" | "standard" | "brisk";
export type AssistMode = "guided" | "immersion" | "zen";
export type FireflyLanguageMode = "both" | "primary" | "english";

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
  genre: string;
  primaryLanguage: PrimaryLanguage;
  duration: number;
  wordCount: number;
  audioUrl: string;
  timingUrl: string;
  timingSource?: "gemini";
  lyricsText?: string;
}

export interface SongProgressRecord {
  bestAccuracy: number;
  bestStreak: number;
  plays: number;
  lastPlayedAt: number;
}

export type WordCatchStatus = "pending" | "caught" | "missed" | "auto";

export interface WordCue {
  id: string;
  cueKey: string;
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
  cueKey?: string;
  spawnTime: number;
  idealTime: number;
  tooLateTime: number;
  flightSeconds: number;
  // 3D trajectory parameters in world space
  originX: number;
  originY: number;
  originZ: number;
  catchX: number;
  catchY: number;
  catchZ: number;
  normX: number;
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
