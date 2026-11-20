# Horizon Ink — Bilingual Song & Timing Library (36 Ready / 36 Total)

This portable library gathers all **36 Suno visualizer tracks** with lossless extracted 48 kHz AAC audio (`.m4a`):
- **36 Ready Tracks** (human-inspected Google AI Studio word-level timings verified against every audio file): bundled in `../public/songs/` and exported across all formats in `exports/`.
- **0 Tracks Awaiting Timing Files**: staged cleanly in `missing-timings/` with lossless `.m4a` audio + verbatim `.txt` lyrics so you can supply AI Studio JSONs anytime.

## Using with Visual Music Lyrics
- Open **Visual Music Lyrics** and drop all files inside `../public/songs/` directly onto the app!
- `public/songs/` contains **strictly** the 36 paired `<id>.m4a` + `<id>.json` files (72 files total) with zero manifest clutter and zero substring filename collisions.
- Every `.json` passes strict `convertGeminiJson()` word-level validation (`0 <= start < end <= duration`, `language: "es" | "en"`, `phrase_id`, `uncertain`).

## Export Formats in `exports/`
- `exports/segments/<id>.segments.json` — Pre-grouped bilingual `Segment[]` JSON ready for `Visual-Music-Lyrics` / custom players.
- `exports/lrc/<id>.lrc` — Enhanced word-timed LRC (`[mm:ss.xx]<mm:ss.xx>word`) for music players & lyric visualizers.
- `exports/vtt/<id>.vtt` & `exports/srt/<id>.srt` — Standard WebVTT and SubRip bilingual caption files.
- `exports/lyrics/<id>.txt` — Suno style prompt + verbatim bilingual lyric sheets.
- `raw-timings/<id>.txt` — Verbatim archived human-inspected Google AI Studio timing exports (so rebuilding works even after clearing `Downloads`).
- `catalog.json` — Machine-readable index of all 36 tracks (`ready` vs `missing-timing`).

## Regenerating / Adding Missing Timings
```bash
npm run songs:gather
```
