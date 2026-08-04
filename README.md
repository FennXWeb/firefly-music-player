# Firefly Music

Firefly is a local-first, highly customizable music player concept for Windows. It runs as an Electron desktop app or directly in a modern browser.

## Run

- Windows installer: run the latest `release/Firefly-*-Setup.exe` after `npm run dist:installer` (or `npm run dist:win`).
- Portable executable: open the latest `release/Firefly-*-Portable.exe` after `npm run dist:portable` (or `npm run dist:win`).
- Instant Windows preview: right-click `start-firefly.ps1` and choose **Run with PowerShell**.
- Electron: run `npm install`, then `npm start`.
- Browser: open `index.html`.

## Implemented in this prototype

- Audio import for MP3, WAV, FLAC, M4A, AAC, OGG, and OPUS, with local playback.
- Album, artist, and track editing, including cover and full-case artwork slots.
- Metadata lookup flow with selectable artwork candidates.
- Multi-source artist-image search across Wikimedia Commons, Deezer, and TheAudioDB, with offline local caching.
- Album shelf mode with drag sorting and an animated, openable jewel case.
- Fullscreen player with visualizer and generated-video queue states.
- Nested master playlists, drag-to-group interactions, and smart playlists.
- Persistent per-track play counts and last-played history, recorded once when each new playback genuinely starts.
- Screenshot-to-playlist workflow with pending tracks and import actions.
- OpenAI and metadata-provider settings, plus an ApiPass-powered Suno Studio with encrypted credentials, V5.5 generation, background task polling, two-variant previews, and local library import.

## Persistent data

Firefly stores the library database, playlists, shelves, artwork references, and settings in `%APPDATA%\firefly-music\Data`. This profile is independent of the portable executable and remains in place when Firefly is rebuilt or upgraded. Existing browser-local Firefly data is migrated into the durable database on first launch.

OpenAI and provider tokens are kept in a separate credentials file and protected with Electron's Windows-backed `safeStorage` encryption. Keys are never stored in the app source or release directory.

## Update channels

Firefly checks for updates on startup and every 30 minutes while running. The channel can be changed in Settings:

- **Stable** reads `updates/latest.json` from the `main` branch.
- **Test** reads `updates/latest.json` from the `beta` branch.

Update downloads are accepted only from GitHub release hosts. If a manifest includes a SHA-256 checksum, Firefly verifies the complete download before offering to launch it. The updater downloads the guided installer; portable builds remain available separately. Both editions keep using the same persistent data directory after an update, and uninstalling Firefly leaves that library data in place.

All routine builds and GitHub prereleases are published from `beta`. The automated workflow cannot publish a stable release. Updating or releasing from `main` requires explicit owner approval.
