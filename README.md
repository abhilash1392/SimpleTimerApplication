# Simple Timer

A lightweight, single-user countdown timer for local use. It provides custom durations, quick presets, a completion buzzer, and a persistent JSON history file.

## Requirements

- Node.js 18 or newer
- A modern browser with JavaScript enabled

The app has no third-party runtime or development dependencies.

## Start the app

From the project directory, run:

```powershell
node server.js
```

Then open [http://localhost:3000](http://localhost:3000). Leave the terminal running while you use the timer. Stop the server with `Ctrl+C`.

The server binds to `127.0.0.1`, so the app is intended to be used on this computer. Do not expose it through a network interface, port forwarding, or a public tunnel.

Opening `index.html` directly or serving it from a static-only server still displays the page, but the history API is unavailable and records cannot be written to the project’s `memory.json`.

To use a different local port in PowerShell:

```powershell
$env:PORT = 3001
node server.js
```

Then visit `http://localhost:3001`.

## Using the timer

1. Enter a duration in minutes (for example, `25`) or minutes and seconds (for example, `2:30`).
2. Or choose a preset: 30 seconds, 1 minute, 5 minutes, 10 minutes, 15 minutes, or 30 minutes.
3. Select **Run**. Use **Pause** and **Resume** as needed.
4. Select **Stop** to end a timer before it completes.

Presets set the duration but do not start the timer. A three-beep alert plays when a timer completes. The browser may require audio to be enabled; the timer itself continues if audio is unavailable.

The displayed countdown is recalculated from a target end time instead of decrementing once per interval callback. This lets it catch up when the browser delays callbacks in a background tab. Pausing captures the remaining time and stops counting; resuming creates a new deadline. Time spent paused is excluded from the recorded elapsed time.

## Timer history

The server stores history in [`memory.json`](./memory.json) in the project directory. It creates the file if it does not exist. The **Download JSON** button exports the history currently loaded by the page.

The file is JSON with a version and a list of timer sessions:

```json
{
  "version": 1,
  "sessions": [
    {
      "id": "unique-id-for-this-run",
      "timestamp": "2026-11-09T08:07:44.034Z",
      "timer": "5 min",
      "timerSeconds": 300,
      "completed": true,
      "endedAt": "2026-11-09T08:12:44.034Z",
      "elapsedSeconds": 300
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Identifier for one run. Completion and stop updates use it to update the same record. |
| `timestamp` | Start time in ISO 8601 UTC format. |
| `timer` | Human-readable requested duration. |
| `timerSeconds` | Requested duration in seconds. |
| `completed` | `true` if the timer reached zero; `false` if it was stopped early or is still in progress. |
| `endedAt` | End time in ISO 8601 UTC format. `null` while in progress. |
| `elapsedSeconds` | Active time rounded down to whole seconds. Time paused is excluded; `null` while in progress. |

Each run is first written as in progress. When it completes or is stopped, that record is updated. If the page or server closes during a run, its record remains incomplete with `endedAt` and `elapsedSeconds` set to `null`; it is not automatically resumed on the next visit.

Existing version 1 records that predate `endedAt` and `elapsedSeconds` remain readable; the server normalizes those fields to `null` when returning history. New records include both fields.

## Project layout

| File | Responsibility |
| --- | --- |
| [`index.html`](./index.html) | Timer interface and accessible control/status elements. |
| [`styles.css`](./styles.css) | Layout, responsive styling, and control appearance. |
| [`script.js`](./script.js) | Duration parsing, countdown, pause/resume, buzzer, and history API requests. |
| [`server.js`](./server.js) | Local static-file server, history API, record validation, and JSON persistence. |
| [`memory.json`](./memory.json) | Persistent timer history. |
| [`test/timer.test.js`](./test/timer.test.js) | Automated timer and persistence tests. |

## Local API

The browser and server communicate using two same-origin endpoints:

| Method and path | Purpose |
| --- | --- |
| `GET /api/history` | Read and validate all history from `memory.json`. |
| `POST /api/history` | Add or update one session by `id`. The request body must be JSON. |

The server accepts only known static-file paths, caps request bodies at 64 KiB, validates session fields, and serializes writes. It writes a temporary file before replacing `memory.json` to reduce the risk of leaving a partially written history file. The API also checks the local Host/Origin and Fetch Metadata headers as a defense against cross-site access.

This is a convenience boundary for a local personal app, not an authentication system. Do not run it as a publicly accessible or multi-user service.

## Tests

Run the test suite from the project directory:

```powershell
node --test
```

The tests use Node's built-in test runner and create temporary history files. They cover:

- Starting and completing a timer, including its end time and elapsed duration
- Stopping after a pause and excluding paused time from elapsed duration
- Catching up when timer interval callbacks are delayed
- Persistence and validation of version 1 history records, including older records

Tests do not modify the project’s `memory.json`.

## Troubleshooting

- **“Unable to connect” or “history is not being saved”:** Start the server with `node server.js` and open `http://localhost:3000`, not the file directly.
- **Port 3000 is already in use:** Set a different `PORT` as shown above, then open the matching localhost URL.
- **History file is malformed:** Check that `memory.json` is valid JSON with `"version": 1` and a `"sessions"` array. Make a backup before editing it manually.
- **No completion sound:** Check the browser tab and system volume. Audio support or browser policies may prevent the buzzer without preventing timer completion.
