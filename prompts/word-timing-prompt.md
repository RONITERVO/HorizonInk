# Word-Timed Bilingual Lyric Alignment Prompt (Audio + Scribe + Original Lyrics)

Analyze the actual audio file (read it with `read_file`) alongside the supplied **original Suno lyrics** and **ElevenLabs Scribe word-level timestamps** to produce a complete, word-timed transcription for bilingual lyric playback in Horizon Ink.

Transcribe the performed song, including every audible target-language (`es`) and English (`en`) vocal: lead singing, quiet backing vocals, whispered or spoken words, repeated phrases, and ad-libs.

English often follows Spanish, but may overlap it. Capture what actually happens in the audio; do not force the languages into non-overlapping time slots. Do not generate English translations that are not audible.

Use the **original Suno lyrics** as a reference for intended wording, `(parentheses)` English echoes, and phrase boundaries, and use the **ElevenLabs Scribe word timings** as high-precision timestamp anchors. However, Scribe may mishear sung words, drop quiet backing echoes, or mix up Spanish/English language tags — always trust the **actual audio performance** over Scribe text or supplied lyrics if they disagree.

## TIMING
- Use numeric seconds measured from the beginning of the audio file (`0`), preserving its original timeline.
- Verify fractional-second word onsets and endings against the audio and Scribe anchors.
- Every entry must satisfy `0 <= start < end <= media duration`.
- Do not round everything to whole seconds, distribute words evenly, snap timings to a regular grid, or merely append decimals to estimates.
- Preserve actual gaps, sustained words, and overlapping voices.
- Mark uncertain wording OR uncertain timing with `"uncertain": true`.
- Prefer one entry per word. If adjacent words cannot be separated reliably, retain the short combined span and mark `"uncertain": true` instead of inventing a boundary.
- For an audible but unintelligible vocal span, use `"text": "..."` with `"uncertain": true` and its supported time interval. Do not invent words.
- Do not create entries for silence or instrumental music (skip Scribe non-speech audio events).

## LANGUAGES AND PHRASES
- Label Spanish words with `"language": "es"` and English words with `"language": "en"`.
- Give every short sung line or ad-lib its own `phrase_id`, such as `"p001"`.
- All words in that phrase share its `phrase_id`.
- Spanish and English phrases must have separate IDs.
- Each repeated occurrence gets a NEW ID, even if its words repeat.
- Do not group an entire verse into one phrase.
- Keep words in their performed order within each phrase.

## OUTPUT
Return JSON matching `prompts/word-timing.schema.json` (`{ "words": [ ... ] }`), where each word entry contains:
`text`, `start`, `end`, `language`, `phrase_id`, `uncertain`.

Illustrative entry format only; do not reuse this example's word or timings:
```json
{
  "words": [
    { "text": "Hola", "start": 1.12, "end": 1.54, "language": "es", "phrase_id": "p001", "uncertain": false }
  ]
}
```

Cover the entire song through the final audible vocal. Before returning, check for missing English responses, omitted repeated sections, invalid timings (`start >= end` or negative), and reused `phrase_id` values.

If you cannot access or analyze the attached audio, say so and stop. Do not simulate an expected transcription.

