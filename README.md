# Horizon Ink

A 1st-person sunset cliffside lyric-catching game built around the **Living Sketchbook** A4 paper visualizer and a **magical flying pen**.

## Features
- **1st-Person Coastal Cliffside**: Sit high on the edge of a mountain cliff overlooking a sandy beach shoreline, foaming ocean surf, and glowing sunset horizon.
- **A4 Living Sketchbook Visualizer**: Faithful real-time canvas rendering of the Living Sketchbook on tilted A4 paper in front of you — complete with stitched binder edge, audio-reactive hand-drawn sun, parallax mountains, ocean ripples, clouds, birds, fish, rain splats, and bilingual `Caveat` handwriting.
- **Magical Flying Pen**: Smoothly sweeps across the A4 paper to write caught Spanish lyrics above the horizon and reflected English translations below the waterline.
- **3D Firefly Word Swarm**: Multilingual words + plausible same-language distractors drift out from the sunset horizon across 3D space like fireflies. Native lyrics (e.g. Spanish) are sung first so their words arrive first, followed by English echoes.
- **No-Fail Study Loop**: Catching a decoy or being too late never ends the game — missed words pencil lightly onto the page and save into your persistent **Study Again** deck with one-click **Practice Phrase** jump-back.
- **6 Built-In Bilingual Songs + Custom Loader**: Play 6 bundled songs right away, or drop in your own audio + Gemini word-timing JSON.

## Controls
- **Click / Tap / Swipe** on 3D fireflies to catch them
- **`1`–`4`** quick-catch nearest fireflies left-to-right, **`Space`** catch hovered or active target
- **`P`** Play / Pause · **`R`** Study Again Deck · **`Esc`** Song Menu

## Scripts
```bash
npm install
npm run dev       # Start local dev server
npm run test      # Run Vitest timing & Gemini import suite
npm run build     # Typecheck + production bundle to dist/
npm run preview   # Preview built release locally
```

