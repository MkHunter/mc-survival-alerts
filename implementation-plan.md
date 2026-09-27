# Implementation Plan — Minecraft Survival HUD Widget
### OBS overlay × Streamer.bot × Twitch Channel Points

Build target: a transparent OBS browser-source widget that replicates the vanilla Minecraft
survival HUD (hotbar queue, XP bar, hunger bar, HP bar, status-effect icons) on the stream.
Viewers buy food with Twitch channel points; Streamer.bot relays redemptions to the widget;
the widget runs the entire survival simulation, consumes queued items, plays eating
animations/sounds, applies status effects, refunds rejected redemptions.

Companion documents: `research-results.md` (architecture research), `minecraft_survival_alerts.ods`
(data source of truth), `data/game-data.json` (generated engine data — see §2).

---

## 0. Architecture (decided)

**Widget-authoritative. Streamer.bot = relay + refund executor. No backend, no hosting.**

```
Viewer ──channel points──▶ Twitch ──EventSub──▶ Streamer.bot ──WS event──▶ Widget (OBS browser source)
                                                              │  owns game loop, state, UI, audio
                                                              ├──WS DoAction──▶ SB "MC Fulfill" (on consume)
                                                              └──WS DoAction──▶ SB "MC Refund"  (on reject)
```

- All game state lives in the widget (browser). Fixed 20-tps simulation loop, rAF rendering.
- Streamer.bot forwards `Twitch.RewardRedemption` events; widget maps reward → food, queues it.
- Consumed → widget calls SB action **MC Fulfill** (redemption marked Fulfilled on Twitch).
- Rejected (queue full / player dead / etc.) → widget calls SB action **MC Refund** (status
  Cancel = points refunded to viewer). Refund sub-actions only work for rewards **created/owned
  by Streamer.bot** — reward creation is therefore a setup step, not a manual Twitch job.
- Zero build system, zero runtime dependencies beyond a vendored copy of the official
  `@streamerbot/client` JS. Everything loads from the local folder via `file://`.

Why this shape (vs C# game state in Streamer.bot / external server / polling): see
`research-results.md` §1 — game loop + animations + timers in C# globals is painful; a
node/python sidecar is an extra moving part with no benefit; polling adds latency and hosting.

---

## 1. Decision log (research §10 open questions — all resolved)

| # | Question | Decision | Rationale / override |
|---|---|---|---|
| 1 | Activity profile default | **`normal`** (6 exhaustion/min ≈ 1.5 hunger pts/min, full bar drains ~13 min) | Forces the buy-food loop; switchable via `?profile=relaxed|normal|hardcore|idle`. Phase 2: channel-point reward that flips mode. |
| 2 | XP meaning | **XP = channel points spent ÷ 10** (`xp.divisor`), vanilla level curve | Directly rewards spending; level-up plays vanilla chime. `xp.mode` column exists for alternatives. |
| 3 | Death | **10 s respawn** overlay; reset HP 20 / hunger 20 / sat 5; **clear all effects** (vanilla); **keep queue**; **halve XP level** (`death.xp_penalty=halve_level`) | Refunding a kept queue is viewer-hostile; halving XP is vanilla-adjacent and simple. All values are `simulation_config` rows. |
| 4 | Queue when head item blocked | **Skip-ahead** (`queue.block_strict=false`) | Pure head-of-line blocking deadlocks the queue when hunger is full. Order is preserved among eligible items; blocked head shows "waiting" shake. |
| 5 | Hazard foods cheap? | **Yes** | Grief economy is the core loop (rotten flesh/pufferfish drain HP → premium heals become valuable). Heal items gated by `eat_when_hp_below` so golden apples are never wasted. |
| 6 | Twitch 50-reward cap | **Phased rollout via `enabled` column** in `channel_points` | Phase A: ~20 rewards (staples + hazards + heals). Phase B: all 42 after pruning other rewards. |
| 7 | Sounds | **Extract from streamer's own Minecraft client jar** (same licensing stance as existing PNGs) | Private-use; don't redistribute the pack. CC alternatives listed in §6 if extraction impossible. |
| 8 | Follows/subs/raids react | **Phase 2** — engine hook `applyExternalEvent(type)` exists from day 1, wired to SB custom events later | Keeps scope tight; design doesn't preclude it. |

Additional build-time decisions: vendored `@streamerbot/client` (no CDN at runtime → widget works
fully offline); game data baked in via generated `<script>` (not `fetch()` — **`file://` pages
cannot fetch local JSON in CEF**); XP granted on redemption acceptance (not on consumption).

---

## 2. Data layer — the ODS is the single source of truth

The spreadsheet was rebuilt and extended during research + this plan (see `research-results.md`
§2, plus the updates below; backups: `*.bak*`). Every game constant, item, effect and reward is
**data**, not code. Adding a food = adding a row.

### 2.1 Sheet schema (current)

| Sheet | Rows | Key columns |
|---|---|---|
| `items` (42 foods) | 43 | `food_id, hunger_value, status_effects[], status_effect_times[ms], display_name, asset_file, saturation_modifier, saturation_value, consume_time_seconds, can_always_eat, stack_size, effect_chance_pct, eat_when_hp_below, suggested_points_cost, suggested_cooldown_seconds, notes, sound_profile` |
| `status_effects` (32) | 33 | `status_effect_id, display_name, type, hud_row, icon_asset, sim_behavior, mechanic_summary` **+ 9 param columns**: `interval_ticks_formula, interval_i_ms, hp_change_per_interval, can_kill, exhaustion_per_tick, damage_multiplier, absorption_hp_per_level, instant_hp_formula, visual_overlay` |
| `simulation_config` | 52 | `key, value, note` — every engine/UI/audio/net constant (tick rate, exhaustion unit, regen rules, queue rules, XP curve, death, persistence, WS defaults, refund/fulfill action names, Twitch caps) |
| `channel_points` (42) | 43 | `food_id, reward_title_suggested, cost, cooldown_seconds, max_per_user_per_stream, anti_spam_note, enabled` |

### 2.2 Data added in this pass (all verified against minecraft.wiki, Java 1.21.x)

- `items.sound_profile` — `eat` | `drink` (milk, honey) | `eat_teleport_fx` (chorus).
- `items.suspicious_stew` pool: **blindness 7000 → 11000 ms** (Java is 11 s; 7 s is Bedrock).
- `items.apple_golden_enhanced` asset → `apple_golden.png` + purple shimmer (CSS) — no new art needed.
- `status_effects` numeric params, e.g.:
  - regen `max(1, 50>>amp)` ticks (I 2.5 s, II 1.25 s, III 0.6 s…), +1 HP/interval
  - poison `max(1, 25>>amp)` (I 1.25 s, II 0.6 s…), −1 HP/interval, **cannot kill** (stops at 1 HP)
  - wither `max(1, 40>>amp)` (I 2 s, II 1 s…), −1 HP/interval, **can kill**; lvl ≥4 capped at 10-tick intervals by vanilla damage immunity
  - hunger `0.005 × level` exhaustion/tick (level = roman numeral = amp+1)
  - resistance damage × `max(0, 1−0.2·lvl)`; **does not reduce starvation**
  - absorption +4 HP/level yellow hearts, deplete first, non-regenerable, vanish at expiry
  - instant health/damage `+4·2^amp` / `−6·2^amp`
  - visual overlays: blindness `dark_vignette`, nausea `hud_sway`, darkness `pulsing_dark_vignette`
- `simulation_config` +25 rows: initial HP/hunger, effect stacking rule, blink threshold,
  icon size, bite/chew/particle timing, gui scale, damage flash, low-HP jitter, absorption wrap,
  effect sort order, sound volume + pools, death effect clearing, chorus FX, persistence key,
  WS host/port, **refund/fulfill action names**, Twitch 50-reward cap.
- `channel_points.enabled` — yes/no flag to phase reward creation under the 50 cap.

### 2.3 Pipeline (already built — `tools/`)

```
minecraft_survival_alerts.ods  ──▶  python3 tools/ods_to_json.py
                                      ├── data/game-data.json      (canonical, human-readable)
                                      └── src/js/gamedata.js       (window.GAME_DATA = {...} — file:// safe)
```

- `tools/ods_dump.py` — TSV dump for eyeballing/auditing.
- `tools/ods_update.py` — idempotent scripted sheet edits (re-runnable; makes timestamped backup).
- `tools/ods_to_json.py` — converter + validator (warns on unknown effect refs, missing assets,
  item/reward mismatches). Run after **every** spreadsheet edit; commit both outputs.
- `data/game-data.json` / `src/js/gamedata.js` are **generated — never hand-edit**.

Current generator output: 42 items, 32 effects, 51 config keys, 42 rewards.
Known data-flagged asset gaps: 2 item sprites (`cake`, `cake_slice`), 11 effect icons (only
`absorption` is food-reachable; others future-proofing) — see §10.

---

## 3. Repository layout (target)

```
mc-survival-alerts/
├── assets/
│   ├── food/*.png, *.png HUD strips, status_effect/*.png   (existing, 80 files)
│   ├── status_effect/absorption.png …                      (to extract — §10)
│   ├── sounds/{eat,drink,burp,teleport,levelup,hurt,death}/*.ogg   (to extract — §10)
│   └── vendor/streamerbot-client.js                        (vendored official client)
├── data/game-data.json                        (generated)
├── src/
│   ├── index.html                             (OBS entry point; plain <script> tags, file:// safe)
│   ├── css/hud.css
│   └── js/
│       ├── gamedata.js                        (generated)
│       ├── config.js                         URL params → merged over GAME_DATA.config
│       ├── engine.js                          pure 20-tps simulation, zero DOM (node-testable)
│       ├── net.js                             SB client wrapper: redemptions in, Fulfill/Refund out
│       ├── audio.js                           sound pools, volume, randomization
│       ├── ui.js                              HUD DOM render (layers, clips, effect icons)
│       ├── anim.js                            eating anim, particles, flashes, shakes, vignettes
│       └── main.js                            bootstrap, accumulator loop, persistence, mock mode
├── tools/                                     (ods_dump, ods_update, ods_to_json, extract_assets — §10)
├── tests/engine.test.js                       (node, zero deps)
├── streamerbot/SETUP.md + import/*.json       (reward/action setup + import payload — §8)
└── implementation-plan.md  research-results.md  minecraft_survival_alerts.ods
```

No bundler, no npm install. `index.html` loads scripts in dependency order; each file is an
IIFE exposing one global namespace (`MCEngine`, `MCNet`, …). Engine file stays DOM-free so
`node tests/engine.test.js` can run it directly.

---

## 4. Engine (`src/engine.js`) — the survival simulation

### 4.1 State shape

```js
state = {
  hp: 20, maxHp: 20, hunger: 20, saturation: 5.0, exhaustion: 0.0,
  absorption: { points: 0, until: 0 },          // yellow hearts
  effects: [ { id:'regeneration', level:2, until: <epoch ms>, nextTickAt: <ms> } ],
  queue: [ { foodId:'steak', redemptionId:'…', rewardId:'…', user:'viewer' } × ≤9 ],
  eating: { slot: 0, foodId:'steak', startedAt: <ms>, durationMs: 1600, bitesDone: 0 } | null,
  xp: { total: 0, level: 0, progress: 0 },      // level curve below
  death: { until: <ms> } | null,
  regenTimers: { slow: 0, fast: 0, starve: 0 }, // ms accumulators
  seenRedemptions: [ '…ids' ≤ 100 ],            // dedupe on reconnect
}
```

Snapshot to `localStorage` (`persistence.localstorage_key = mc_hud_state_v1`) on every state
change (throttled 1 s) + on `beforeunload`. Note: in CEF, `file://` origins share one
localStorage namespace — the namespaced key avoids collisions; if a future build blocks
localStorage on `file://`, the widget degrades to session-only state (documented risk, §14).

### 4.2 Fixed-timestep loop

Minecraft runs 20 ticks/s. The engine does the same: `main.js` keeps a wall-clock accumulator,
`engine.tick(dtMs = 50)` is called exactly 20×/s regardless of rAF speed; rendering is decoupled
(`ui.render(state, nowMs)` on each rAF). Time-scale multiplier supported for testing
(`?timescale=16` fast-forwards: call tick() with scaled dt).

### 4.3 Tick pipeline (exact order, all constants from `game-data.json`)

```
tick(dt):
 1. death?            countdown → respawn (reset hp 20, hunger 20, sat 5, clear effects+absorption, xp halve). Skip 2–7.
 2. exhaust +=        activity_profile.exhaustion_per_min / 1200     (per tick)
                      + hunger effect: 0.005 × level                  (level = amp+1)
 3. drain             while exhaust ≥ 4.0: exhaust -= 4; saturation>0 ? saturation-- : (hunger>0 && hunger--)
 4. regen (hp<20)     hunger ≥ 18 (slow): regenTimers.slow += dt; ≥4000ms → hp++, exhaust += 6
                      hunger == 20 && saturation>0 (fast): timers.fast += dt; ≥500ms → hp++, exhaust += 1.5
                      (fast rule wins while saturated; when saturation hits 0 → slow rule)
 5. starvation        hunger == 0: timers.starve += dt; ≥4000ms → damage(1, floor=1, source='starve')
 6. effect DoT        regen:  interval = max(1, 50>>amp) ticks → hp++ (cap 20; no hunger cost)
                      poison: max(1, 25>>amp) → damage(1, floor=1)   [cannot kill]
                      wither: max(1, 40>>amp) → damage(1, floor=0)   [can kill]
 7. expirations       effects past until → remove; absorption expired → points 0
                      (1.20.2+ rule: absorption effect also removed when its hearts hit 0)
 8. eating            if eating: progress += dt; bite every 200ms (sound+particles);
                        at durationMs → finishEat()
                      else: startEat(first eligible item)  // §4.5
 9. death check       hp ≤ 0 → die() (10 s overlay, clears effects; queue kept; redemptions during death → refund)
10. xp                nothing per tick (added on redemption, §4.7)
```

`damage(amount, source)`:
```
if resistance active && source != 'starve': amount = floor(amount × max(0, 1−0.2·lvl))
absorption.points -= amount → leftover hits hp   (yellow hearts deplete first)
hp = max(floor, hp − leftover); flash + shake if hp dropped; floors: poison 1, starve 1, wither 0
```

### 4.4 Eating rules (vanilla-faithful)

`finishEat(item)`:
```
hunger     = min(20, hunger + item.hunger)
saturation = min(hunger, saturation + item.saturation)      // cap rule from sim config
roll effects: each {chance_pct} (raw chicken 30%, rotten flesh 80%, poisonous potato 60%)
              stew: pick 1 uniformly from item.stew_pool (roll at consumption — gamble stays a surprise)
apply effect e: existing? → keep max(level), keep max(until, now+e.duration)   // no downgrade, no stacking
                new?       → push {id, level, until, nextTickAt}
instant: saturation effect → +1 hunger +2 saturation per level, no icon
absorption: points += 4 × level (cap: display wraps rows; effect persists until its until)
clears: milk → all effects removed; honey → poison removed (both instant, duration 0)
chorus: teleport FX (purple particle burst + sound + cosmetic HUD shake)
burp sound; net.fulfill(redemptionId); dequeue; persist
```

### 4.5 Queue machine (9 slots = hotbar)

- Redemption accepted → append `{foodId, redemptionId, rewardId, user}` to first free slot.
  Queue full → reject → **refund** (reason `queue_full`).
- Consumption is FIFO with **skip-ahead** (`queue.block_strict=false`):
  eligible = (`can_always_eat` || `hunger < 20`) && (`eat_when_hp_below` null || `hp <= gate`).
  Engine eats the first eligible item from the head; blocked items keep their position and show
  a "waiting" shake. Gates are checked at **start** only — if state changes mid-bite (1.6 s),
  the item still completes (vanilla behavior), hunger clamps at 20.
- Head-of-queue slot gets `inventory_selection_bar.png` highlight; eating slot shows chew anim.
- Special gates from data: `apple_golden` eats only at HP ≤ 14, `apple_golden_enhanced` at HP ≤ 10.

### 4.6 Effect stacking + HUD state (rules from `simulation_config`)

- Stacking: **duration → longer wins; level → higher wins**. Never downgrade, never add.
- Effect HUD derived state: remaining time, blink flag (`effects.blink_threshold_s = 10`),
  sort `soonest_expire_leftmost`, positive row top / negative+neutral row bottom (vanilla 1.19+).
- Hunger effect active → hunger bar uses `hunger_bar_meat_status*` tinted strips.
- Poison active → `hp_bar_heart_poison.png` hearts; wither → hearts via CSS `brightness(0)`;
  absorption → yellow hearts = `hp_bar_heart.png` runtime-tinted (§6.4/§10.3).

### 4.7 XP math (from `simulation_config`)

- On accepted redemption: `xp.total += reward.cost / xp.divisor (10)`.
- Level curve (vanilla): xp needed in level L = `L<16 ? 2L+7 : L<31 ? 5L−38 : 9L−158`.
  Recompute `level` + `progress` from total; on level-up → vanilla chime.
- Death: `level = floor(level/2)`, progress 0 (`death.xp_penalty=halve_level`; `none|reset` options).

### 4.8 Determinism & tests

Engine is pure (no DOM, no timers — takes `now`/rng injection). All randomness (effect chance,
stew pool, eat-sound pick) via injectable `rng(seedableMulberry32)` so tests are reproducible.

---

## 5. UI (`ui.js`, `anim.js`, `hud.css`) — vanilla HUD replication

### 5.1 Layout geometry (GUI units; 1 GUI px = `ui.gui_scale` (3) screen px at 1080p; `?scale=` override)

Bottom-center column, anchored to source bottom (source = 1920×1080):

| Element | Size (GUI px) | Position | Assets |
|---|---|---|---|
| Hotbar | 182×22 | centered, bottom 0 | `inventory_bar.png`; selector `inventory_selection_bar.png` 24×24 on active slot (offset −1) |
| XP bar | 182×5 | directly above hotbar | `xp_bar.png` + `xp_bar_full.png` clipped by progress; level number above, `#80FF20` + 2px black shadow |
| HP hearts | 81×9 (10 icons, 8px pitch) | left half, ~10 GUI px above hotbar | `hp_bar.png` container + `hp_bar_heart.png` fill (clip) |
| Hunger | 81×9, mirrored right | right half, same row as hearts, right-aligned, drains left-to-right of the row (mirror of hearts) | `hunger_bar.png` + `hunger_bar_meat.png` (+`_half`, `…_1` shake frames, `…_status` tints) |
| Absorption hearts | up to 10 more | appended right of hearts / wraps to row above | tinted heart sprite |
| Status effects | 18×18 icons | top-right column of widget, + timer text | `assets/status_effect/<icon>` |

All sprites `image-rendering: pixelated`. Text (XP level, mm:ss timers, respawn countdown) in
**Monocraft** (SIL-OFL; woff2 embedded) with pixel-drop shadow; fallback monospace.

### 5.2 Fill rendering (strips = rows of 10 sprites)

- HP: fill strip clipped to `hp/20 × 81` px. HP is half-heart granularity (integer 0–20): odd HP
  clips mid-heart (left-half heart visible) — matches vanilla half-heart look closely.
- Hunger: layer `hunger_bar_meat_half.png` (all 10 half icons) then `hunger_bar_meat.png` clipped
  to full points → half drumsticks show where a full one is clipped away.
- XP: `xp_bar_full.png` clipped to `progress × 182`.
- Saturation 0 → hunger row swaps to `…_1` (82px) shake frames (vanilla jitter).
- Poison hearts / wither hearts / absorption hearts per §4.6.

### 5.3 Layer stack (z-order bottom→top)

hotbar → slot items (16×16 sprites scaled) → XP bar → hearts/hunger rows → absorption row →
status-effect column → eating anim/particles → damage flash → vignette overlays → death overlay.

### 5.4 Eating animation (per research §6.3 — Minecraft has no official HUD eat anim; Bedrock-style)

1. Selector highlights the eating slot.
2. Item sprite (scaled ×4) rises above hotbar center, **chew loop**: X-tilt toward mouth +
   scale bounce at `eat.chew_anim_hz` (4 Hz) for the item's `consume_time_ms` (1.6 s default,
   dried kelp 0.8 s, honey 2.0 s).
3. Every `eat.bite_interval_ms` (200 ms = vanilla bite cadence): play random `eatN.ogg`,
   spawn `eat.particles_per_bite` (3) crumb particles (2–3 px squares, colors sampled from the
   item sprite) that fall briefly.
4. Milk/honey → drink pool instead; chorus → teleport sound + `chorus.particle_burst` purple
   burst + `chorus.hud_shake_ms` cosmetic shake of the whole HUD.
5. Finish → burp.ogg, item applied (§4.4), removed from queue, slots shift, selector moves on.

### 5.5 Feedback FX

- HP loss → `hp_bar_white.png` overlay flash `ui.damage_flash_ms` (500) + 1-frame HUD shake.
- Low HP (≤ `ui.low_hp_jitter_hp`, 4) → hearts jitter (vanilla low-health wobble).
- Effect about to expire (<10 s) → icon blinks (vanilla).
- Nausea → sinusoidal sway of whole HUD (`hud_sway`, CSS keyframes, subtle — stream stays watchable).
- Blindness → dark vignette over the widget bounds (`dark_vignette`, moderate opacity).
- Death → red vignette + "Respawning in Ns" center text, HUD dims; queue shown but frozen.

### 5.6 Mock/dev mode (critical for iteration)

`?mock=1` renders a debug panel (off-stream copy of the URL): set HP/hunger/saturation manually,
inject synthetic redemptions (any food), `?timescale=` slider (0–16×), state export/import JSON,
"kill player" button. Same engine — panel is pure UI sugar. Also lets the streamer demo/test
without spending points.

---

## 6. Audio (`audio.js`)

- Pools per key (config): `eat_pool` (eat1–3), `drink_pool` (drink1–3), `burp`, `teleport`,
  `levelup`, `hurt` (on damage), `death`. Random pick per play, slight rate jitter (0.9–1.1).
- Volume: `sound.volume` (0.8) master; OBS-side per-source mixing via browser-source
  "Control audio via OBS" (eat sounds can get loud — streamer can duck it).
- CEF ignores autoplay policy → no user-gesture needed. `<audio>`/WebAudio both fine on `file://`.

### 6.1 Sound sources (pick one — decision 7)

| Option | Files | License standing |
|---|---|---|
| **A (chosen): own client jar** | see §10 extraction paths | Mojang assets — private stream use, consistent with the PNGs already in `assets/`; do not redistribute the pack |
| B: CC alternatives | freesoundslibrary.com "Minecraft Eating" (CC-BY 4.0), Pixabay SFX (Pixabay), OpenGameArt burp packs (CC-BY-SA) | attribution file if CC-BY used |

---

## 7. Networking (`net.js`) — Streamer.bot protocol

### 7.1 Client

Vendored official client (download once: `https://cdn.jsdelivr.net/npm/@streamerbot/client/dist/streamerbot-client.js`
→ `assets/vendor/streamerbot-client.js`, pinned version noted in a comment). MIT, ~10 KB.

```js
const sb = new StreamerbotClient({ host, port, endpoint:'/', password: pw }); // host/port/pw from URL params
sb.on('Twitch.RewardRedemption', ({ data }) => onRedemption(data));
// consumption:
sb.doAction({ name: cfg['fulfill.action_name'] }, { redemptionId, rewardId, user, foodId });
// rejection:
sb.doAction({ name: cfg['refund.action_name'] },  { redemptionId, rewardId, user, reason });
```

- Raw wire format (for the vendored-file sanity check / custom fallback):
  `{"request":"Subscribe","id":"<uuid>","events":{"Twitch":["RewardRedemption"]}}` and
  `{"request":"DoAction","id":"<uuid>","action":{"name":"MC Refund"},"args":{…}}`.
- Auth: if a WS password is set, pass it in the constructor; protocol = `Hello` → SHA-256
  challenge/response `Authenticate`. Per docs, only `SendMessage` strictly requires auth, and
  `DoAction`/`Subscribe` work without it — set the password anyway.
- Reconnect: official client retries; additionally re-subscribe on reconnect and keep a
  `seenRedemptions` ring (100) to ignore replayed events after a drop.

### 7.2 Redemption → queue (event payload from docs, verified)

```json
{ "data": { "redemptionId": "…", "reward": { "id": "…", "title": "Eat a Steak", "cost": 500 },
            "user": { "login": "viewer", "name": "Viewer" }, "status": "unfulfilled", "isTest": false } }
```

Flow per redemption:
1. Dedupe by `redemptionId`.
2. Map `reward.title` (trimmed, case-insensitive) → `food_id` from `GAME_DATA.rewards`;
   fallback: optional baked `reward.id → food_id` map (config key `rewards.id_map`) for renamed
   titles. Unknown reward → ignore + console warn (not ours → no refund possible).
3. Reject if: queue has no free slot (`queue_full`) · player dead (`player_dead`) ·
   item `enabled=false` (`item_disabled`). → refund with reason; else accept: enqueue + XP.

### 7.3 SB actions called by the widget (created once — §8.3)

- **`MC Fulfill`** — sub-action Twitch → Rewards → **Update Redemption Status: Fulfilled**,
  redemption ID from action arg `%redemptionId%`. Optional chat sub-action: "🍜 %user% 's
  %foodId% was devoured!" (toggleable in SB).
- **`MC Refund`** — Update Redemption Status: **Cancel** (= refund points), args
  `%redemptionId%`, `%rewardId%`, `%user%`, `%reason%`. Optional chat sub-action:
  "@%user% queue is full (%reason%) — points refunded".

`DoAction` `args` become action arguments in SB, hence the `%argName%` placeholders above.

---

## 8. Streamer.bot setup (one-time, streamer checklist — ships as `streamerbot/SETUP.md`)

1. **Connect Twitch** in SB (EventSub; any 0.2.x).
2. **Create the channel-point rewards IN Streamer.bot** (Platforms → Twitch → Channel Point
   Rewards → Add). Must be SB-owned or refunds silently fail (docs FAQ). One per enabled row of
   the `channel_points` sheet: title / cost / cooldown / per-user cap exactly from
   `data/game-data.json → rewards[]`. Titles must match the sheet because the widget maps by
   title. Phase A ≈ 20 rewards, Phase B all 42 (Twitch cap 50 — prune others first).
3. **WebSocket Server**: enable, port 8080, set password, allow events (at minimum
   `Twitch.RewardRedemption`).
4. **Actions `MC Fulfill` + `MC Refund`** per §7.3 — either click them together (2 min) or import
   `streamerbot/import/mc-actions.json` (draft template; **first export one manually-created
   action from the installed SB version and diff the schema** — import formats drift between
   SB releases; fix GUIDs/subaction keys to match, then ship the import file).
5. **Sanity test**: OBS source → URL with `?host=127.0.0.1&port=8080&pw=…&scale=3`; open SB
   action/test UI; spend the cheapest real reward; watch event arrive, item queue, eat, fulfill.
   Then force a full queue (mock panel) and confirm refund + points returned on Twitch side.

---

## 9. OBS deployment

- Source type **Browser** → Local file `src/index.html`; width 1920 height 1080; FPS 60;
  custom CSS field **empty** (page body transparent already).
- URL params on the source: `?host=127.0.0.1&port=8080&pw=<ws password>&scale=3&profile=normal`.
  The `pw` sits in a local file URL only OBS reads — fine for a local WS; don't commit it anywhere.
- **"Shutdown source when not visible" OFF** and **"Refresh browser when scene becomes active"
  OFF** (else game resets on scene switches). State additionally survives via localStorage.
- Audio: tick "Control audio via OBS" → dedicated mixer channel for eat/burp sounds.
- After asset/data edits: right-click source → Refresh (cache busting).
- Performance: one DOM layer set + CSS anims + ≤ 30 particles — trivial for a 1080p browser source.

---

## 10. Asset gaps & extraction (build task `tools/extract_assets.py`)

All extraction from the streamer's **own Minecraft client jar**
(`~/.minecraft/versions/<ver>/<ver>.jar` or `%APPDATA%\.minecraft\…`) — it's a zip; script globs
and copies:

| Need | Jar path | Destination |
|---|---|---|
| Eat sounds (3) | `assets/minecraft/sounds/entity/generic/eat/eat*.ogg` | `assets/sounds/eat/` |
| Drink sounds | `assets/minecraft/sounds/entity/generic/drink/drink*.ogg` | `assets/sounds/drink/` |
| Burp | `assets/minecraft/sounds/entity/player/burp/*.ogg` | `assets/sounds/burp/` |
| Chorus teleport | `assets/minecraft/sounds/item/chorus_fruit/teleport*.ogg` | `assets/sounds/teleport/` |
| Level-up | `assets/minecraft/sounds/entity/player/levelup/*.ogg` (or `random/level_up*`) | `assets/sounds/levelup/` |
| Hurt / death (optional) | `…/entity/player/hurt/*.ogg`, `…/entity/player/death/*.ogg` | `assets/sounds/hurt|death/` |
| Cake sprite | `assets/minecraft/textures/item/cake.png` (whole-cake item sprite; slice = wedge crop or `textures/block/cake_top.png` crop) | `assets/food/cake.png` (+ `cake_slice.png`) |
| Missing effect icons | `assets/minecraft/textures/mob_effect/<id>.png` (absorption, saturation, instant_health, instant_damage, glowing, luck, unluck, conduit_power, dolphins_grace, health_boost, darkness) | `assets/status_effect/` |

Notes: counts of numbered variants (eat1..3, burp…) vary by version — glob, don't hardcode.
Ogg/vorbis plays fine in CEF; no conversion needed.

### 10.3 Runtime-generated art (no files needed)

- **Enchanted golden apple**: `apple_golden.png` + purple shimmer overlay (CSS animated glow).
- **Wither hearts**: heart strip `filter: brightness(0)`.
- **Absorption yellow hearts**: `hp_bar_heart.png` runtime-tinted (canvas pixel-shift red→yellow
  once at load, cached dataURL — crisper than CSS hue-rotate; hue-rotate acceptable fallback).
- **Absorption icon**: extracted `mob_effect/absorption.png` (only food-reachable missing icon).

---

## 11. Testing plan

### 11.1 Engine unit tests (`node tests/engine.test.js`, seeded rng, fake clock)

Golden numbers (from wiki-verified data — these are the values people usually get wrong):

| Case | Assert |
|---|---|
| Exhaustion unit | ex 4.0→0 drains exactly 1 sat; sat 0 → drains hunger |
| Activity normal | 0.005 ex/tick → 1 point/40 s → 1.5 pts/min (full bar ≈ 13 min) |
| Slow regen | hunger 18, hp 15 → +1 HP/4 s, +6 ex per heal |
| Fast regen | hunger 20, sat > 0 → +1 HP/0.5 s, +1.5 ex per heal; stops when sat 0 |
| Starve | hunger 0 → 1 HP/4 s, floor 1 HP (Normal difficulty) |
| Poison II | 1 HP/0.6 s (12 ticks), floor 1 HP, survives at 1 HP |
| Wither II | 1 HP/1.0 s (20 ticks), floor 0, kills |
| Pufferfish eat | nausea 15 s + hunger III 15 s + poison II 60 s applied; hunger III adds 0.015×20×15 = 4.5 exhaustion total |
| Rotten flesh 80% | seeded rng: rolls hunger I 30 s; other seed skips |
| Golden apple gates | hp 20 → stays queued ("waiting"); hp ≤ 14 → eats |
| Skip-ahead | queue [steak(blocked), dried_kelp] at hunger 20 → kelp eats first |
| Stacking | regen II 5 s then regen I 8 s → level II, 8 s remain (never downgraded) |
| Milk / honey | milk clears all; honey clears poison only, keeps others |
| Suspicious stew | 9-way pool uniform; blindness rolls 11 s (not 7) |
| XP | cost 500 → 50 XP → level 4, progress 10/15 (7+9+11+13=40 XP reaches L4, +15 to L5; curve `2L+7`) |
| Death | hp 0 via wither → 10 s dead, effects cleared, queue intact, xp halved, redemptions refunded |
| Invariants (soak, 10k ticks random ops) | 0 ≤ hp ≤ 20, sat ≤ hunger, queue ≤ 9, no NaN |

### 11.2 Integration / visual

- `?mock=1` panel drives all flows without Twitch (queue full refund path needs SB though —
  test with real cheap reward + full queue).
- Screenshot diff: HUD at hp 20/13/1, hunger 20/11/0, saturated vs not, vs vanilla reference
  screenshots (streamer's own game at same GUI scale).
- Audio: chew cadence = one sound per 200 ms; burp on finish; milk uses drink pool.
- Latency smoke: real redemption → sprite in hotbar < 1 s.

---

## 12. Milestones (each with acceptance criteria)

**M0 — Data pipeline (DONE, this session)**
spreadsheet extended+verified (42 items / 32 effects / 51 config / 42 rewards), `tools/` built,
`data/game-data.json` + `src/js/gamedata.js` generated and validated.

**M1 — Engine headless (`engine.js`, `tests/`)**
All §11.1 unit tests green in node. Acceptance: golden table passes; soak invariant clean.

**M2 — Static HUD (`index.html`, `hud.css`, `ui.js`)**
All bars render from arbitrary state via mock mode: hotbar+items, XP, hearts (half-heart clip),
hunger (half drumsticks, shake frames, status tints), absorption row, effect column with
timers/blink, death overlay. Acceptance: screenshot parity vs vanilla at scale 3.

**M3 — Eating + audio (`anim.js`, `audio.js`)**
Chew loop, bites, particles, burp, drink/teleport variants, damage flash, low-HP jitter,
nausea sway, blindness vignette. Acceptance: 3-item queue drains with correct per-item timing
(dried kelp visibly faster, honey slower).

**M4 — Streamer.bot integration (`net.js`)**
Real redemption → queue; consumption → Fulfill on Twitch dashboard; full queue → Refund returns
points; dedupe on reconnect; SB console shows no errors. Acceptance: §8 checklist end-to-end
with one cheap reward + one forced refund.

**M5 — OBS deployment + streamer docs**
`streamerbot/SETUP.md` (setup above) + `README` quickstart; soak test 24 h (state persists,
no drift: assert simulated hunger math matches wall clock ±1 %). Acceptance: streamer completes
checklist unassisted.

**M6 — Polish**
XP chime, death cycle polish, Monocraft woff2, effect-icon blink ordering, config reference
(§13) documented in README.

**M7 (Phase 2, optional)** — follows/subs/raid → `applyExternalEvent` hooks via SB custom
events ("Raid = damage wave", "Sub = golden apple"); "Risk Mode" reward flipping activity
profile; danger_events mode; per-viewer contribution leaderboard in a sidecar page.

Suggested order is strictly M1→M5; M2/M3 can interleave with M4 prep.

---

## 13. Config reference (URL params, override `simulation_config`)

| Param | Default | Meaning |
|---|---|---|
| `host` / `port` / `pw` | `127.0.0.1` / `8080` / — | Streamer.bot WS server |
| `scale` | `3` | GUI pixel scale |
| `profile` | `normal` | `idle\|relaxed\|normal\|hardcore` activity (exhaustion/min 0/3/6/12) |
| `volume` | `0.8` | master SFX volume |
| `timescale` | `1` | tick multiplier (testing) |
| `mock` | `0` | debug panel |
| `fresh` | `0` | ignore saved localStorage state (cold start) |

Everything else (queue rules, gates, XP, death, blink thresholds…) lives in the spreadsheet —
the URL stays minimal.

---

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| SB refunds fail for non-SB-owned rewards | Setup creates rewards in SB (§8.2); M4 test proves refund before going live |
| Twitch 50-reward cap | `enabled` column phases rollout; checklist prunes old rewards first |
| `file://` fetch blocked in CEF | Data baked as `window.GAME_DATA` script — no fetch anywhere |
| localStorage shared/reset quirks in CEF `file://` | Namespaced key + `?fresh=1`; graceful session-only fallback; OBS shutdown options OFF |
| SB WS disconnect (SB restart, PC sleep) | Client auto-retry + re-subscribe + redemption dedupe ring |
| DoAction without auth = any local process can trigger actions | Localhost-only threat model; set WS password anyway; it's a local overlay |
| Mojang asset licensing | Same stance as existing PNGs: private stream use, never redistribute pack; CC-sound option documented |
| Eat sounds too loud on stream | Per-source OBS mixer routing + `sound.volume` |
| Spreadsheet regeneration drops formatting | ODS edits are data-level (scripts make `.bak_*` backups); content re-verified by `ods_to_json` warnings |
| Import-schema drift for SB actions | Import file verified against an exported action from the installed SB version before shipping (§8.4) |

---

## 15. Definition of done

1. All §11 tests green; 24 h soak stable.
2. Full loop live: viewer spends points → food appears in hotbar → eats with animation+sound →
   hunger/HP/effects react → redemption marked Fulfilled → queue-full redemption refunded.
3. HUD visually indistinguishable from vanilla Minecraft at the same GUI scale (side-by-side
   screenshot check).
4. Streamer can repeat the whole setup from `streamerbot/SETUP.md` alone.
5. Data-driven: adding a food/effect/price never requires engine code changes — spreadsheet
   row + `tools/ods_to_json.py` + OBS refresh.
