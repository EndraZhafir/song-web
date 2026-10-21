# song-web

The React + TypeScript frontend client for **Track Guesser** — a lightweight web-based song-guessing game where players identify songs from progressively expanding audio snippets.

> **Status:** Early / Phase 1 Prototype (Single-Player Core Loop). Actively under development.

---

## Overview

`song-web` provides the interactive audio player, snippet-clamping logic, scoring system, and artist-scoped autocomplete combobox that connects to the [`song-api`](../song-api) Go backend.

---

## Core Gameplay Mechanics

* **Progressive Snippet Clamping:**
  * Every round starts with the audio snippet clamped to **1 second** via HTML5 `<audio>` `onTimeUpdate` events.
  * Players can unlock longer durations (**5s**, **10s**, and **15s**) using the **Unlock / Skip** buttons.
  * Buttons for durations less than or equal to the currently unlocked time are automatically disabled.
* **Scoring & Escalating Penalties:**
  * **Starting Pool:** `1,000` points per round (floored at `0`).
  * **Skip Penalty:** $\text{Penalty}_{\text{skip}} = 100 + (n_{\text{skips}} \times 50)$ *(e.g., `-100`, `-150`, `-200`...)*.
  * **Wrong Guess Penalty:** $\text{Penalty}_{\text{incorrect}} = 150 + (n_{\text{incorrect}} \times 50)$ *(e.g., `-150`, `-200`, `-250`...)*.
* **Scoped Autocomplete & Fuzzy Matching:**
  * **Artist Discography Scoping:** Toggle one or multiple seeded artists to dynamically merge their discographies into the active round pool.
  * **Fuzzy Validation:** Player guesses are sanitized (lowercased, stripped of punctuation and remaster/featuring tags) and compared using normalized Levenshtein similarity so minor typos are forgiven.

---

## Tech Stack

* **Framework:** React 18 + TypeScript
* **Build Tool:** Vite
* **Data Fetching:** TanStack Query (`@tanstack/react-query`)
* **Icons:** `lucide-react`

---

## Project Structure

```text
song-web/
├── src/
│   ├── App.tsx        # Main game UI, audio clamping, scoring, and fuzzy matching
│   ├── main.tsx       # React root & TanStack QueryClientProvider setup
│   └── index.css      # Dark-mode styling and layout
├── index.html         # HTML entry point
├── package.json       # Scripts and dependencies
├── tsconfig.json      # TypeScript configuration
└── vite.config.js     # Vite config with /api proxy to http://localhost:8080
```

---

## Getting Started

### Prerequisites
Make sure the Go backend (`song-api`) is running on `http://localhost:8080` and has at least one artist seeded in `game.db`.

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Development Server
```bash
npm run dev
```
Open `http://localhost:5173` in your browser. Requests to `/api/*` are automatically proxied to `http://localhost:8080`.

### 3. Build for Production
```bash
npm run build
```

---

## Roadmap

* [x] **Phase 1:** Clamped HTML5 audio player, 5s/10s/15s skip controls, progressive scoring, multi-artist pool selector, and fuzzy-matched combobox.
* [ ] **Phase 2:** Multiplayer lobby UI (`/room/ABCD`), WebSocket state synchronization, and real-time scoreboards.
* [ ] **Phase 3:** Genre/Era pack selection and production bundling.
