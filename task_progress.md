# AudioTruyen — Build Progress Tracker

> This file exists so any AI model can resume the build from where it left off.
> Update task status as each sub-task completes.

## Task 1 — Project Scaffold & Config
- [x] Init Next.js in `frontend/`
- [x] Init FastAPI in `backend/`
- [x] Create `.gitignore`, `.env.example`, `task_progress.md`
- [x] Setup CORS + middleware

## Task 2 — Web Scraper (Backend)
- [x] Scrape chapter text from URL (`GET /api/scrape/chapter`)
- [x] Scrape full chapter list/TOC (`GET /api/scrape/toc`)
- [x] Rate limiting / polite delays

## Task 3 — TTS Service (Backend)
- [x] Gemini ADC TTS service (`services/tts_gemini.py`)
- [x] OpenAI TTS service (`services/tts_openai.py`)
- [x] MiniMax TTS service (`services/tts_minimax.py`)
- [x] Google Translate TTS fallback (`services/tts_gtranslate.py`)
- [x] Provider fallback router (`routers/tts.py`)

## Task 4 — Audio Save (Backend)
- [x] POST `/api/audio/save` — write audio bytes to local disk
- [x] MP3 / WAV format support
- [x] Persist last-used directory path

## Task 5 — Frontend: Chapter Sidebar
- [x] Input novel URL → fetch TOC
- [x] Scrollable chapter list with current highlight
- [x] Finished/read status badge on chapters (✅ when chapter is completed)

## Task 6 — Frontend: Reader Panel & TTS Player
- [x] Chapter text display (word-span rendering for highlight)
- [x] Play/Pause/Stop TTS controls
- [x] Auto-advance to next chapter toggle (only fires at end of audio, not at 90%)
- [x] Active TTS provider badge + fallback toast
- [x] Real-time word highlighting synced to audio playback

## Task 7 — Frontend: Recording Controls
- [x] Start/Stop recording
- [x] Save directory picker (remembers path)
- [x] Format selector (MP3/WAV)
- [x] File saved confirmation toast

## Task 8 — Frontend: Settings Panel
- [x] TTS provider selector + API key fields
- [x] Gemini service account JSON path config
- [x] Voice + speed/pitch controls

## Task 9 — Word-Highlight & Chapter Completion (NEW)
- [x] Backend: `POST /api/tts/synthesize-with-timing` — returns audio + word timings (GCloud TTS)
- [x] Backend: `tts_gemini.synthesize_with_timing()` using `enable_word_time_offsets`
- [x] Frontend types: `WordTiming`, `finishedChapterUrls`, `highlightedWordIndex`
- [x] Frontend store: `wordTimings`, `setWordTimings`, `setHighlightedWordIndex`, `markChapterFinished`
- [x] TTSPlayer: fetch timing data, drive highlight via `timeupdate` event, mark chapter at 90-95%
- [x] ReaderPanel: render words as individual `<span>` elements with highlight class
- [x] ChapterSidebar: show ✅ badge on finished chapters

## Task 10 — Security & Polish
- [ ] CORS locked to localhost only
- [ ] URL validation (truyenplus.vn only for scraper)
- [ ] Rate-limit scrape endpoints
- [ ] React error boundaries + toast notifications

## Task 11 — Final Integration & Testing
- [ ] E2E: scrape → TTS → record → save
- [ ] Fallback chain test (disable Gemini, verify OpenAI kicks in)
- [ ] README with setup instructions

---
Last updated: 2026-03-11 — Task 9 completed (word-highlight + chapter completion)
