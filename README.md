# Ignifire Music

Ignifire is a local-first, highly customizable music player for Windows. It runs as an Electron desktop app or directly in a modern browser.

## Run

- Windows installer: run the latest `release/Ignifire-*-Setup.exe` after `npm run dist:installer` (or `npm run dist:win`).
- Portable executable: open the latest `release/Ignifire-*-Portable.exe` after `npm run dist:portable` (or `npm run dist:win`).
- Instant Windows preview: right-click `start-ignifire.ps1` and choose **Run with PowerShell**.
- Electron: run `npm install`, then `npm start`.
- Browser: open `index.html`.

## Implemented in this prototype

- Audio import for MP3, WAV, FLAC, M4A, AAC, OGG, and OPUS, with local playback.
- Album, artist, and track editing, including cover and full-case artwork slots.
- Metadata lookup flow with selectable artwork candidates.
- Multi-source artist-image search across Wikimedia Commons, Deezer, and TheAudioDB, with offline local caching.
- Album shelf mode with drag sorting and an animated, openable jewel case.
- Source-aware shelf spine cropping for generated cases, full spreads, back-cover scans, and dedicated spine scans.
- Fullscreen player with visualizer and generated-video queue states.
- Nested master playlists, drag-to-group interactions, and smart playlists.
- Persistent per-track play counts and last-played history, recorded once when each new playback genuinely starts.
- Screenshot-to-playlist workflow with pending tracks and import actions.
- OpenAI and metadata-provider settings, plus an ApiPass-powered Suno Studio with encrypted credentials, V5.5 generation, background task polling, two-variant previews, and local library import.

## Persistent data

Ignifire stores the library database, playlists, shelves, artwork references, and settings in `%APPDATA%\firefly-music\Data`. The legacy folder name is intentionally retained so existing libraries upgrade in place. This profile is independent of the executable and remains in place when Ignifire is rebuilt or upgraded. Existing browser-local data is migrated into the durable database on first launch.

OpenAI and provider tokens are kept in a separate credentials file and protected with Electron's Windows-backed `safeStorage` encryption. Keys are never stored in the app source or release directory.

## Update channels

Ignifire checks for updates on startup and every 30 minutes while running. The channel can be changed in Settings:

- **Stable** reads `updates/latest.json` from the `main` branch.
- **Beta** reads `updates/latest.json` from the `beta` branch.
- **Testing** is the development branch and does not publish a public updater feed.

Update downloads are accepted only from GitHub release hosts. If a manifest includes a SHA-256 checksum, Ignifire verifies the complete download before offering to launch it. The updater downloads the guided installer; portable builds remain available separately. Both editions keep using the same persistent data directory after an update, and uninstalling Ignifire leaves that library data in place.

New development lands on `testing`. Promotion from `testing` to `beta` publishes the public beta build; promotion from `beta` to `main` requires explicit owner approval. The public repository makes every branch readable, while GitHub write access remains limited to authorized collaborators.
