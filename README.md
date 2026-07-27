# fishHelper

Your personal saltwater fishing assistant for the US East Coast (RI / MA / NH).

## About this project

This entire project was built with AI (Kiro + Claude) as the primary author, with me reviewing, directing architecture decisions, and correcting the AI's output using my own coding knowledge. The AI writes the code; I validate the logic, catch mistakes, and steer the design.

One notable evolution: the system originally used a full AI agent loop (LLM picks tools → executes → LLM picks again → ...), which was flexible but expensive in tokens. I redesigned it into a **two-step hybrid architecture** — a lightweight LLM call extracts the user's intent first, then deterministic code handles the fixed pipeline (resolve coordinates → fetch data → generate report). This cut token usage by ~43% while keeping the same output quality. The full AI fallback still exists for less common operations, but 90%+ of queries now skip the expensive multi-round tool-selection loop entirely.

## What is this?

fishHelper is a chat bot that tells you whether a fishing spot is good to fish right now, today, or any future day. Just send it a message and it gives you a full analysis: tides, wind, weather, wave conditions, water temperature, species ratings, and the best time to go.

## Where can I use it?

fishHelper is available on three platforms via bot WebSocket connections — pick whichever you already use:

- **Telegram**
- **Discord**
- **WeCom (企业微信)**

All three connect to the same brain, same data. Your saved spots and analysis are shared across all platforms.

## What can I ask?

Just type naturally. Examples:

| You say | What happens |
|---------|--------------|
| `Fort Adams 现在怎么样?` | Current conditions + analysis (next high/low tide, wind, species ratings) |
| `Fort Adams 今天怎么样?` | Today's full analysis (from now through next 24 hours) |
| `Fort Adams 明天怎么样?` | Tomorrow's full-day analysis (00:00 - 24:00) |
| `How is Fort Adams this Saturday?` | That day's full analysis |
| `军校明天怎么样?` | Works with saved nicknames too (军校 = Massachusetts Maritime Academy) |
| `41.48, -71.33` | Just send coordinates — gets current analysis for that spot |
| `我的钓点` / `list spots` | Shows all your saved spots as clickable buttons |

## Quick spot selection (Discord + Telegram)

When you ask "我的钓点" or "list spots", the bot replies with **clickable buttons** — one for each saved spot. Tap any button and you instantly get today's fishing analysis for that spot. No need to type the name out.

## What's in the analysis?

Every analysis includes:

- **Current Time** + Sunrise / Sunset
- **Tides** — next high/low (current mode) or full day schedule (prediction mode), each event on its own line
- **Water Temperature**
- **Wind** — current snapshot or 3-hour block breakdown
- **Air Temperature** — same format as wind
- **Weather** — same format
- **Wave Height + Wave Period** — 3-hour blocks
- **Precipitation / Thunderstorm probability**
- **Active Alerts** (NWS marine warnings)
- **Species Ratings** — star ratings for 8 target species:
  Striped Bass, Bluefish, Scup, Black Sea Bass, Tautog, Fluke, Weakfish, Squid
- **Best Fishing Window** — when to go and why

You also get a `.txt` attachment with the full detailed report + raw data JSON.

## Managing spots (admin only)

If you're an admin, you can save new fishing spots:

> "Add a spot called Church Woods Hole, coordinates 41.515, -70.655, note: first fishing spot"

Non-admin users can query and analyze spots, but cannot add or modify them.

## Data sources

All data comes from free US government APIs (no paid subscriptions):
- NOAA CO-OPS (tides, water level, currents)
- NWS (weather, wind, alerts)
- NOAA NDBC (waves, sea temperature)
- USGS (river data)
- NOAA bathymetry (water depth)
- suncalc (sunrise/sunset, moon phase)

## Technical details

For development setup, deployment, architecture, and environment variables, see [`docs/design.md`](docs/design.md) and [`docs/tasks.md`](docs/tasks.md).
