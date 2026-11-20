# Horizon Ink

A 1st-person sunset cliffside lyric-catching game built around the **Living Sketchbook** A4 paper visualizer and a **magical flying pen**.

## Features
- **1st-Person Coastal Cliffside**: Sit high on the edge of a mountain cliff overlooking a sandy beach shoreline, foaming ocean surf, soaring seabirds, ambient cliffside fireflies, and a glowing sunset horizon.
- **A4 Living Sketchbook Visualizer**: Faithful real-time canvas rendering of the Living Sketchbook on tilted A4 paper in front of you — complete with stitched binder edge, audio-reactive hand-drawn sun, parallax mountains, ocean ripples, clouds, birds, fish, rain splats, and bilingual `Caveat` + CJK calligraphy.
- **Magical Flying Pen**: Smoothly sweeps across the A4 paper to write caught Spanish or Chinese lyrics above the horizon and reflected English translations below the waterline.
- **3D Firefly Word Swarm + Beat Rings**: Multilingual words + same-language distractors drift out from the sunset horizon across 3D space with contracting beat rings. Native lyrics (Spanish or Chinese) arrive first, followed by English echoes, and caught words arc along Bezier curves directly onto their paper slot.
- **No-Fail Study Loop & Auto-Mastery**: Catching a decoy or being too late never ends the game — missed words pencil lightly onto the page and save into your persistent **Study Again** deck with cross-song **Practice Phrase** jump-back, and catching them cleanly in a replay automatically graduates them to Mastered.
- **36 Timed Bilingual Songs + Portable Visualizer Library**: Includes all 36 lossless 48 kHz `.m4a` tracks with human-inspected Google AI Studio word timings (34 Spanish+English and 2 Chinese+English), searchable by title/genre/language, plus custom audio + JSON loading.

## Music Library & External Visualizers (`public/songs/` & `library/`)
- **`public/songs/`**: Contains strictly all 36 `<id>.m4a` + `<id>.json` pairs (72 files total) with zero manifest clutter so you can drag-and-drop the entire folder straight into **Visual Music Lyrics**.
- **`public/songs-manifest.json`**: Game manifest consumed by Horizon Ink.
- **`library/exports/`**: Pre-generated portable `.lrc` (enhanced word-timed), `.vtt`, `.srt`, `.segments.json`, and verbatim `.txt` lyrics for all 36 timed tracks, indexed by `library/catalog.json`.
- **`library/raw-timings/`**: Self-contained archive of all 36 human-inspected Google AI Studio timing exports (so `npm run songs:gather` works offline with zero dependency on external `Downloads`).

## Controls
- **Click / Tap / Hold & Swipe** across 3D fireflies to catch them
- **`1`–`4`** quick-catch nearest fireflies left-to-right, **`Space`** catch hovered or active target
- **`Tab` / `→`** skip long intros / instrumental solos right to the next lyric
- **`P`** Play / Pause · **`R`** Study Again Deck · **`Esc`** Song Menu · **HUD Speed (`1.0×` / `0.85×` / `0.75×`) & SFX toggle**

## Scripts
```bash
npm install
npm run dev           # Start local dev server
npm run songs:gather  # Rebuild manifest & exports from scripts/song-sources.json
npm run test          # Run Vitest timing, library & scheduler suite
npm run build         # Typecheck + production bundle to dist/
npm run preview       # Preview built release locally
```
