# Horizon Ink × Lexicommons Integration Plan

## Vision
Integrate **Horizon Ink** as an added game inside a fork of [`Imaginative-Prompting/lexicommons`](https://github.com/Imaginative-Prompting/lexicommons), where Lexicommons serves as the vocabulary & FSRS spaced-repetition backend and Horizon Ink provides the 3D sunset-cliffside musical lyric-catching gameplay powered by an automated **Antigravity CLI (`agy`) + Suno API (`sunoapi.org`) + ElevenLabs Scribe** pipeline.

---

## Architecture Overview

### 1. Lexicommons Fork (Vocabulary & SRS Backend + Host Shell)
- **Role**: Supplies the learner's vocabulary state (what words/phrases are learned, slipping, due, or upcoming), lesson/pack progression, and FSRS (`ts-fsrs`) memory updates.
- **Integration Points Observed in `lexicommons`**:
  - **Client-side Study & Progress**:
    - `public/js/study/scheduler.js` (FSRS memory replay across `read`, `hear`, `say` skills)
    - `public/js/study/progress.js` (`unitState`, `studiedUnits`, `record`)
    - `public/js/know/word-index.js` (`isUnderstood`, `wordEntries`)
    - `public/js/study/content.js` & `packs.js` (`WORDS`, `CHUNKS`, `ITEMS`, `TOPICS`, `WORD_PACKS`)
  - **Server / MCP Layer**:
    - `src/practice.ts` (`PracticeRoom` Durable Object holding `StudyRecord` snapshots)
    - `src/coach.ts` & `src/mcp-coach.ts` (`study_summary`, `study_concept`, `study_lesson`, `study_misses`)
    - `src/mcp-packs.ts` (`get_pack_guide`, `create_pack`, `update_pack`)
- **UI Placement**:
  - Mount Horizon Ink inside the Lexicommons fork (e.g. `/app/games/horizon-ink/` or a dedicated game route launched from Study / AI / Games), pre-bundling Horizon Ink's Vite + Three.js build or importing `three` from `public/vendor/`.
  - **Lexicommons Vocabulary Bridge**:
    - **Inbound (Lexicommons -> Song Generator)**: Export `{ language, learned_words, weak_or_due_words, new_target_words, theme_or_lesson }` from the learner's active `StudyRecord` / `progress.js` / `content.js`.
    - **Outbound (Horizon Ink -> Lexicommons)**: Feed caught/missed lyric words back into Lexicommons study progress / review logs (distinguishing `hear` / `read` exposure vs missed words in Study Again) without violating Lexicommons's `games-bible.md` rules.
- **License Note**: `lexicommons` is licensed under **AGPL-3.0** (`LICENSE`). Any hosted or distributed fork must comply with AGPL-3.0 source-sharing terms.

---

### 2. Local Agent & Media Sidecar (Background + Front Agent)
Because neither a browser PWA nor a Cloudflare Worker can spawn `agy` CLI or safely hold local private API keys for third-party Suno/ElevenLabs runs, a **local sidecar service** (Node or Rust, similar to `SkyrimVRControlCenter/crates/bard-engine`) runs alongside the local Lexicommons copy:
- **Front Agent**: Triggered from the Horizon Ink / Lexicommons UI when the learner requests a custom song, selects a mood/genre, or clicks **"Generate Song from My Vocab"**, streaming progress events (writing lyrics -> generating audio -> transcribing -> aligning -> ready to play) over SSE/WebSocket.
- **Background Agent**: Pre-generates/queues the next song in the background from upcoming due/new Lexicommons vocabulary so the player always has fresh, personalized tracks ready with zero wait.
- **MCP Connection**: The local agent can also connect to Lexicommons's `/mcp` endpoint using a personal access token (`lct_...`) to read `study_summary`, `study_lesson`, `study_misses`, and optionally create study packs for newly introduced song words.

---

### 3. Automated Song Creation & Alignment Pipeline

#### Step A — Vocabulary Selection (`lexicommons`)
- Query the learner's current language (initially `"es"` Spanish, extensible to `"fr"`, `"de"`, `"it"`, `"pt"`, `"ja"`, `"nl"`, `"ru"`).
- Pick:
  - **Anchor set (`learned_words`)**: 10–25 known/familiar words for natural comprehension and rhythm.
  - **Review/reinforce set (`due_words`)**: Words due or slipping in FSRS.
  - **Introduce set (`new_words`)**: 3–6 new words from the next Lexicommons lesson/topic pack.

#### Step B — Style & Bilingual Lyrics Generation (`agy` CLI)
- **Style Reference**: Uses `prompts/suno-style-bible.md` (converted from `D:\Projects\Utilities\SkyrimVRControlCenter\runtime\bard\data\history.turns.json`, preserving all 98 style tags, 3+ minute Suno pacing tags, and the `(in parentheses)` English echo formula) — plus `prompts/suno-history.acp.json` for full ACP turn history when desired.
- **Invocation**:
  ```sh
  agy --model gemini-3.8-flash-low --output-format json --dangerously-skip-permissions \
    --json-schema prompts/suno-song.schema.json \
    -p "Read prompts/suno-style-bible.md ..."
  ```
  *(Verified working via test run on `gemini-3.8-flash-low`: produced valid JSON with `title`, `style`, `vocal_gender`, `lyrics`, `learned_words_used`, and `new_words_used` in ~12s.)*

#### Step C — Audio Generation (`https://sunoapi.org/`)
- Submit custom-mode generation using the `agy` output (`custom_mode: true`, `prompt: lyrics`, `tags`/`style: style`, `title`, `vocalGender: vocal_gender`).
- Poll the SunoAPI task status endpoint from the local sidecar until audio MP3 URLs are complete, then download the MP3 locally (and optionally keep both Suno variants for user pick or auto-pick).

#### Step D — Word-Level Timestamp Extraction (ElevenLabs Scribe)
- Send the generated MP3 to ElevenLabs Speech-to-Text (`POST https://api.elevenlabs.io/v1/speech-to-text`) using the latest Scribe model (`scribe_v2` or latest available Scribe model ID) with:
  - `timestamps_granularity: "word"`
  - `tag_audio_events: false` (or filtered out before alignment)
- Extract raw word tokens with fractional-second `start` and `end` timestamps.

#### Step E — Audio + Scribe + Lyrics Reconciliation (`agy` CLI)
- **Empirical Verification**: Tested `agy -p` with `read_file` on `public/songs/keep-dancing.mp3` — `agy` **can directly hear and analyze MP3 audio** (accurately identified `"Sun is shining"` at ~0:03–0:07).
- Pass `agy` ALL FOUR inputs in one reconciliation prompt (`prompts/word-timing-prompt.md` + `--json-schema prompts/word-timing.schema.json`):
  1. Path to the downloaded `.mp3` audio (instructing `agy` to inspect it with `read_file` for acoustic verification of overlapping echoes, quiet backing vocals, and actual onset/offset).
  2. The **ElevenLabs Scribe** word-level timestamp JSON (as high-precision timing anchors).
  3. The **original Suno lyrics** (for intended Spanish lead vs `(English)` echo wording and line structure).
  4. The Horizon Ink alignment schema rules (`text`, `start`, `end`, `language: "es"|"en"`, `phrase_id: "p001"..`, `uncertain: boolean`).
- Run `convertGeminiJson()` validation + `tests/scheduler.test.ts` invariants on the resulting JSON before registering the song in the playable library/manifest.

---

## Open Items / Clarifications to Lock Down Before Implementation
1. **OS / Runtime Setup**: `lexicommons` local dev (`docs/self-host.md`) currently targets macOS / Linux / WSL, whereas `agy` CLI and Windows tools run on the Windows host. Decide whether the local sidecar runs on Windows (calling `agy.exe`) with the Lexicommons fork running in WSL or native Windows Node 24.
2. **SunoAPI.org Exact Endpoint Variant**: Confirm the exact base URL / payload keys on your `sunoapi.org` dashboard (`/api/v1/generate` vs `/suno/submit/music`, `mv`/`model` version string such as `V5_5`, and polling vs callback URL).
3. **ElevenLabs Scribe Model ID**: Confirm the exact latest Scribe `model_id` enabled on your ElevenLabs API key (`scribe_v2` vs `scribe_v3` if available on your tier).
4. **Target Languages Beyond Spanish**: Horizon Ink's `types.ts` and `geminiImport.ts` currently hardcode `"es"` vs `"en"` (`Language = "es" | "en"`). Decide whether v1 of the Lexicommons integration stays Spanish-only (matching `history.turns.json`'s main Spanish focus) or generalizes `Language` to any Lexicommons target language (`fr`, `de`, `ja`, `zh`, `nl`, etc.).
5. **Lexicommons Progress Write-Back Semantics**: Decide whether catching/missing words in Horizon Ink counts as formal FSRS `hear`/`read` reviews in Lexicommons or feeds a separate song-exposure / "Study Again" deck without altering strict lesson FSRS intervals.
6. **Audio & Song Storage**: Decide where generated MP3 + JSON pairs live — local sidecar disk (dev/personal mode) vs R2 bucket in a self-hosted Cloudflare Worker deployment.

