# MC Survival HUD — OBS widget

Vanilla Minecraft survival HUD as a transparent OBS browser source. Viewers buy food with
Twitch channel points; Streamer.bot relays redemptions; the widget runs the full survival
simulation (hunger, saturation, exhaustion, regen, poison/wither, absorption, death) and
refunds rejected redemptions.

## Quickstart

1. **Streamer.bot** — follow `streamerbot/SETUP.md` (rewards must be created **in**
   Streamer.bot or refunds fail).
2. **OBS** — Browser source → local file `src/index.html`, 1920×1080, 60 fps:
   ```
   src/index.html?host=127.0.0.1&port=8080&pw=<ws password>&scale=3&profile=normal
   ```
   "Shutdown when not visible" OFF · "Refresh when scene active" OFF.
3. **Test without Twitch** — open same URL + `&mock=1` in any browser: debug panel,
   synthetic redemptions, timescale slider, kill button.

## Dev

```
node tests/engine.test.js      # 65 engine tests (golden values from the wiki)
python3 tools/ods_to_json.py   # regenerate data after spreadsheet edits
```

- Spreadsheet `minecraft_survival_alerts.ods` = single source of truth → `data/game-data.json`
  + `src/js/gamedata.js` (both generated, never hand-edit).
- Engine is DOM-free (`src/js/engine.js`) — fixed 20 tps, seedable rng, node-testable.
- No build, no npm; loads via `file://`. Streamer.bot client vendored in `assets/vendor/`.

## Repo map

```
src/index.html        OBS entry point
src/js/               config, engine, net, audio, ui, anim, main
src/css/hud.css       vanilla HUD styling
assets/food|status_effect|*.png   sprites
assets/sounds/{eat,drink,burp,teleport,levelup,hurt,death}/   sound pools
assets/vendor/        streamerbot-client.js (MIT)
assets/fonts/         Monocraft.ttf (SIL-OFL)
streamerbot/          SETUP.md + action import draft
tests/engine.test.js
tools/                ods → json pipeline
```

## Known asset gaps (need your own client jar)

- `assets/food/cake.png`, `cake_slice.png` — extract `textures/item/cake.png` from
  `~/.minecraft/versions/<ver>/<ver>.jar` (zip). Placeholder letter-icon renders until then.
- `assets/status_effect/absorption.png` (+10 future icons) — `textures/mob_effect/<id>.png`.
- Player death sound is the classic hurt pitched 0.8 (this jar ships no
  `entity/player/death`); drop real `death*.ogg` into `assets/sounds/death/` if wanted.

Sound pools came from the streamer's own client jar — private stream use, do not
redistribute the pack.

## Licensing note
Minecraft sprites/sounds: Mojang assets, private stream overlay use. Monocraft: SIL OFL
(IdreesInc/Monocraft). @streamerbot/client: MIT.
