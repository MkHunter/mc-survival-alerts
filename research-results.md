# Research Results — Minecraft Survival HUD Widget for OBS (Twitch Channel Points + Streamer.bot)

> Research phase output. Goal: everything a developer needs to write a solid implementation plan for an
> OBS browser-source widget that simulates a Minecraft survival HUD (hotbar/inventory queue, XP bar,
> hunger bar, HP bar) on a transparent background. Viewers buy food via Twitch channel points;
> Streamer.bot is the middleman between Twitch and the widget.

---

## 1. Executive summary & recommended architecture

**Recommended architecture: "widget-authoritative, Streamer.bot as relay + refund executor".**

```
Twitch ──(channel point redemption)──▶ Streamer.bot ──(WebSocket event)──▶ OBS Browser Source widget (HTML/JS)
                                          ▲                                  │
                                          └──────(doAction: refund)──────────┘
```

- The **widget (OBS browser source) owns the game loop**: hunger/saturation/exhaustion/HP/XP state,
  consumption queue, animations, sounds, status-effect timers. All state lives in the browser.
- **Streamer.bot** is configured once:
  1. It **creates/imports the channel point rewards** (critical: see §7.3 — rewards must be owned by
     Streamer.bot for refunds to work).
  2. It **forwards every reward redemption** to the widget over its built-in WebSocket server
     (`Twitch.RewardRedemption` event, payload includes `rewardId`, `redemptionId`, cost, user).
  3. It executes a **"Refund Redemption" action** that the widget calls via WebSocket `DoAction`
     when the queue is full or a redemption is otherwise rejected.
- No backend server, no hosting, no polling. One `.html` file + assets folder dropped as an OBS
  browser source. Works offline on the streaming PC.

**Why not alternatives:**

| Alternative | Why rejected |
|---|---|
| Streamer.bot C#/variables hold game state | Game loop (20 tps sim, timers, effect stacking) in C# globals is painful; state sync to widget needs a 2nd channel anyway; harder to reload/iterate |
| External node/python process | Extra moving part; must be started with OBS; no benefit over in-widget logic |
| Static widget polling a web service | Latency, hosting cost, auth headaches; Streamer.bot WS is already event-driven |

**Economic design insight (important for tuning):** HP/hunger only deplete via time-simulated
exhaustion and via *hazard foods* (poison/wither/hunger effects). That creates the core loop:
viewers grief cheaply (rotten flesh, pufferfish), which drains HP, which makes premium heal foods
(golden apples, milk) valuable. Price accordingly (cost table in the spreadsheet, sheet
`channel_points`).

---

## 2. Spreadsheet audit — `minecraft_survival_alerts.ods` (UPDATED)

Original sheet `items` had 4 columns (`food_id, hunger_value, status_effects, status_effect_times`),
~37 rows, several wrong/blank values and ID/asset mismatches. The spreadsheet has been **rebuilt in
place** (backup: `minecraft_survival_alerts.ods.bak`) into 4 sheets:

| Sheet | Contents |
|---|---|
| `items` | 42 foods × 16 columns: vanilla-verified hunger, **saturation** (modifier + value), **consume time**, `can_always_eat`, stack size, effect chance %, durations (ms), suggested **point cost** & cooldown, per-item HP gate, notes |
| `status_effects` | All 32 effects: display name, positive/negative, HUD row (top/bottom), icon asset mapping, sim behavior class, mechanic summary |
| `simulation_config` | Every engine constant as data: tick rate, exhaustion rules, regen/starvation, activity profile presets, queue rules, XP formula, death/respawn |
| `channel_points` | One row per food: suggested reward title, cost, cooldown, per-user cap |

### 2.1 Corrections made to original data (Java Edition verified)

| Item | Was | Now (vanilla) |
|---|---|---|
| `carrot` hunger | 3 | **4** (Java 1.9+) |
| `potato_baked` hunger | 5 | **6** |
| `sweet_berries` hunger | 1 | **2** (Java) |
| `mutton_raw` effect "30% hunger" | wrong | **no effect** (that's raw chicken only) |
| `spider_eye` poison time | 4000 ms | **5000 ms** (0:05) |
| `potato_poisonous` effect time | blank | **5000 ms**, 60% chance |
| `enhanced_golden_apple` durations | all 120000 | **Absorption IV 2:00, Regen II 0:20, Resistance I 5:00, Fire Res I 5:00** (Java) |
| `fish_pufferfish_raw` effects | included `dmg_stop` (unclear) | **Nausea I 0:15, Hunger III 0:15, Poison II 1:00** |
| `beetroot soup` id | space in id | `beetroot_soup` |
| `steak` | bare id | mapped to asset `beef_cooked.png` (steak = cooked beef) |
| `raw_chicken/raw_mutton/raw_porkchop/raw_beef` | mixed ids | renamed to match asset files (`chicken_raw`, `mutton_raw`, `porkchop_raw`, `beef_raw`) |

### 2.2 Missing metadata that was added (was required for a modular engine)

- **Saturation** (hidden buffer, the real driver of "when hunger drops") — modifier + computed value
  per item.
- **Consume time** — 1.6 s default; dried kelp 0.8 s; honey bottle 2.0 s (milk drinks 1.6 s).
- **`can_always_eat`** — vanilla rule: golden apple, enchanted golden apple, chorus fruit, honey
  bottle, milk, suspicious stew are consumable even at full hunger; everything else requires
  hunger < 20. This is the vanilla version of the "minimum requirements" gate.
- **Effect chance %** (raw chicken 30%, rotten flesh 80%, poisonous potato 60%).
- **Suggested channel point cost + cooldown** per item.
- **`eat_when_hp_below`** optional per-item gate (e.g. golden apple 14, enchanted 10) — implements
  "only consume when it can fulfil HP needs" without wasting apples at full HP.
- `simulation_config` sheet: every constant the engine needs (see §3).

### 2.3 Missing assets (need art before ship)

| Needed | Where used | Suggestion |
|---|---|---|
| `cake.png` / cake slice | cake_slice, cake rows | draw 16×16 fan sprite (slice = triangle wedge) |
| Enchanted golden apple | apple_golden_enhanced | reuse `apple_golden.png` + purple shimmer/tint via CSS filter |
| `absorption_effect.png` | golden apples (Absorption) yellow hearts also need a yellow-heart sprite — none in `assets/` | add icon + yellow heart variant (CSS hue-rotate red→yellow is an acceptable shortcut) |
| `saturation_effect.png` | suspicious stew (dandelion) | optional — effect is instant, icon never shows |
| Wither hearts (black) | wither effect | CSS `filter: brightness(0)` on heart sprite, no new asset needed |
| Sound files | eating/burp (§6.4) | extract from own Minecraft install (`assets/minecraft/sounds/entity/generic/eat/eat1..3.ogg`, `entity/player/burp/burp.ogg`) or use CC sources listed there |

---

## 3. Vanilla mechanics reference (Java Edition 1.21.x — canonical for this project)

Bedrock differs in a few places (noted). Values below are what the simulation must implement;
all are already encoded in the spreadsheet.

### 3.1 The three food variables

- **hunger** 0–20 (10 drumsticks, 2 points each) — the visible bar.
- **saturation** 0–hunger (hidden buffer). Drains *before* hunger. Cap: `saturation = min(hunger, saturation + food_saturation)`.
- **exhaustion** 0–4.0 (hidden). At ≥ 4.0: reset to 0 and drain 1 **saturation** if any, else 1 **hunger**.

Eating adds: `hunger += item.hunger`, `saturation = min(hunger, saturation + item.saturation_value)`.

### 3.2 Exhaustion sources (exact values)

| Action | Exhaustion |
|---|---|
| Swimming | 0.01 / meter |
| Breaking a block | 0.005 |
| Sprinting | **0.1 / meter** |
| Jumping | 0.05 (sprint-jump 0.2) |
| Attacking | 0.1 |
| Taking damage | 0.1 / instance |
| Hunger status effect | 0.005 × level / tick (→ removes 1 point every 40/level seconds) |
| Hunger effect full 0:30 (rotten flesh / raw chicken) | totals 3.0 |
| Hunger III full 0:15 (pufferfish) | totals 4.5 |
| Natural regen heal | **6.0 per 1 HP healed** |

### 3.3 Regen / starve rules (the "survival formula")

- `hunger ≥ 18` → heal **1 HP every 4 s**, costing 6 exhaustion (saturation first, then hunger).
- `hunger = 20 && saturation > 0` (Java "saturation boost") → heal **1 HP every 0.5 s**, costing 1.5 saturation per HP.
- `hunger = 6` → cannot sprint (cosmetic relevance only).
- `hunger = 0` → **1 HP starvation damage every 4 s**, stops at 1 HP (Normal difficulty — use this).
- When saturation hits 0, the hunger bar **jitters/shakes** (use the `hunger_bar_*_1` 82px frames for the shake frames).

### 3.4 The stream-overlay problem & solution

Vanilla has **no passive hunger drain** (a standing player never starves). The widget must deplete
over time or the game never plays itself. Solution (encoded in `simulation_config`): a configurable
**activity profile** that emits synthetic exhaustion per minute:

| Profile | Exhaustion/min | Hunger points/min | Full 20-bar empty time* |
|---|---|---|---|
| idle | 0 | 0 | never |
| relaxed | 3 | 0.75 | ~27 min |
| **normal (default)** | 6 | 1.5 | ~13 min |
| hardcore | 12 | 3 | ~7 min |

\* rough: ignores saturation buffer (real time longer with high-saturation food) and regen drain.

HP damage sources (vanilla-faithful default = `effects_only`): poison/wither DoT, starvation at
hunger 0, hazard foods. Optional `danger_events` mode: 1 HP every N seconds (simulated mobs), or
Streamer.bot-triggered events (follower = heal, raid = damage wave — open question §10).

### 3.5 XP bar (proposed meaning — open question §10)

Vanilla XP-to-next-level formula: `L<16: 2L+7`, `16–30: 5L−38`, `31+: 9L−158` (level 30 = 1395 total XP).
Proposal: XP = channel points spent ÷ 10 (configurable); level-up plays the vanilla level-up chime.
Assets: `xp_bar.png` (empty) / `xp_bar_full.png` (fill, 182×5, clip by progress).

---

## 4. Queue semantics (interpretation of "minimum requirements")

User requirement: *"items will be consumed in order of the queue as long as it is able to be
fulfilled the hunger and/or hp levels as minimum requirements for each individual item."*

Mapped to vanilla + per-item gates:

1. **FIFO, 9 slots** (matches hotbar). Each redemption = 1 unit appended to first free slot.
2. **Gates checked per item at consumption time**:
   - plain food: requires `hunger < 20` (vanilla "can't eat when full");
   - `can_always_eat` items: no hunger gate (vanilla rule);
   - optional `eat_when_hp_below` (spreadsheet column): e.g. enchanted apple only auto-consumed at HP ≤ 10.
3. **Consumption animation**: head item plays eating animation + chew sounds for its consume time,
   then is removed and effects apply.
4. **Blocked head**: if the head item's gates are unmet (e.g. hunger full), it shows a waiting
   indicator and the engine looks at the next item behind it (skip-ahead, default) — or pure
   head-of-line blocking (`queue.block_strict=true`). Recommend skip-ahead to avoid deadlocks; order
   is otherwise preserved.
5. **Queue full** → refund the redemption (§7) and (optional) chat notice.

---

## 5. Status effects — display & simulation rules

HUD rules to replicate (vanilla 1.19+ look): icons **top-right**, positive effects on the top row,
negative (+neutral) below; soonest-to-expire leftmost; amplifier as roman numeral; **remaining time
as text under the icon** (mm:ss or seconds); effect about to expire (< 10 s) blinks. Icons are
18×18 sprites in `assets/status_effect/`, render at HUD scale (×3 at 1080p → 54 px).

Simulation rules per effect family (full table in spreadsheet sheet `status_effects`):

| Effect | Sim behavior |
|---|---|
| Regeneration | heal 1 HP per 2.5 s (I) / 1.25 s (II); no hunger cost |
| Absorption | +4 HP/level yellow hearts above HP bar, absorb damage first, vanish at expiry; **needs missing yellow-heart asset** |
| Poison | 1 HP / 1.25 s (I) / 0.6 s (II); stops at 1 HP; hearts tint green (`hp_bar_heart_poison.png`) |
| Wither | 1 HP / 2 s (I) / 1 s (II); can kill; hearts tint black (CSS brightness(0)) |
| Hunger | exhaustion pump 0.005×lvl/tick; hunger bar tinted yellow-green (`hunger_bar_meat_status*`) |
| Resistance | incoming damage ×0.8^lvl (does not stop starvation) |
| Fire Resistance / Water Breathing / Night Vision / Invisibility / Jump Boost / Strength / Weakness / Speed / Slowness / Haste / Mining Fatigue / Levitation / Luck / Unluck / Glowing / Bad Omen / Hero of the Village / Conduit Power / Dolphin's Grace / Health Boost / Darkness | icon + timer only (no food source in current item set) — display-only for future-proofing |
| Saturation | instant hunger/saturation refill on tick — never render icon |
| Instant Health / Damage | instant — never render icon |

**Suspicious stew** = random 1-of-9 pool on redemption (per-flower table, in `items` sheet notes):
poison I 11 s, blindness I 7 s, weakness I 7 s, wither I 7 s, night vision I 5 s, jump boost I 5 s,
regeneration I 7 s, fire resistance I 3 s, saturation (instant). Show the rolled effect only after
consumption (it's a gamble for viewers).

**Clearing effects**: milk bucket clears *all*; honey bottle clears *poison only*. Both instant (duration 0).

**Chorus fruit**: no status effect — random teleport. Widget treatment: purple particle burst +
teleport sound, cosmetic shake of the whole HUD. Fun, cheap redemption.

---

## 6. UI replication spec

### 6.1 Asset geometry (measured from `assets/`)

| Asset | Size | Role |
|---|---|---|
| `inventory_bar.png` | 182×22 | hotbar, 9 slots |
| `inventory_selection_bar.png` | 24×24 | slot selector (use on the head-of-queue slot) |
| `xp_bar.png` / `xp_bar_full.png` | 182×5 | XP bar empty/full |
| `hp_bar.png` | 81×9 | 10 empty hearts (container) |
| `hp_bar_heart.png` | 81×9 | 10 filled hearts (clip by HP) |
| `hp_bar_heart_poison.png` | 81×9 | poison-tinted hearts |
| `hp_bar_white.png` | 81×9 | white/hearts flash (damage flash) |
| `hunger_bar.png` | 81×9 | empty hunger container |
| `hunger_bar_meat.png` / `_half` | 81×9 | drumstick fill / half |
| `hunger_bar_meat_1.png` / `_half_1` | 82×9 | shake frames (saturation = 0 jitter) |
| `hunger_bar_meat_status*.png` | 81/82×9 | yellow-green variants (Hunger effect active) |
| `assets/food/*.png` | 16×16 | item sprites (file name = `food_id`) |
| `assets/status_effect/*.png` | 18×18 | effect icons |

Hearts/drumsticks are 9×9 sprites at 8px pitch on an 81px strip (10 icons). Render layers:
container strip → fill strip clipped via CSS `clip-path`/`object-position` per point → tint overlay.

### 6.2 Layout (vanilla HUD positions, GUI scale = scale factor)

Vanilla HUD, bottom-center, in GUI units (1 GUI px = `scale` screen px; **default `scale = 3` at
1080p**, expose as URL param `?scale=`):

- Hotbar: centered horizontally, bottom edge 0 px; 182×22.
- XP bar: directly above hotbar (182×5, bottom at hotbar top; level number centered above it, green `#80FF20` with black shadow).
- HP hearts: left-aligned above XP bar, right edge of first heart at x=+1, row bottom ≈ 5 px above XP bar (heart 9px + 5px gap → hearts sit 10 px above hotbar top... implement: hearts row bottom at hotbar_top − 10; hunger mirrored on the right).
- Hunger: mirrored (fills right-to-left visually — drumsticks deplete from left? no: hunger depletes from right side of the row *drumstick icons drain from the left edge of the right-aligned row*, mirror of hearts).
- Absorption hearts: appended after the 10th heart (second row when overflow > 10 hearts).
- Status effects: top-right column, 18×18 icons + amplifier + timer text.
- All at `image-rendering: pixelated`.

### 6.3 Eating animation (no 1st-person hand exists in the widget)

Vanilla Java shows: item held, screen edge "eat" wobble, crumbs, chew sounds, burp at end. Recommended
widget treatment (approved approach — Minecraft has no official HUD eating anim; borrow Bedrock feel):

1. Selected slot highlight (`inventory_selection_bar.png`) on the head item.
2. Item sprite (16×16, scaled) lifts center-screen above the hotbar and plays a **chew loop**:
   quick X-tilt/rotate toward the mouth + slight scale bounce at ~4 Hz for the consume duration;
   crumb particles (2–3 px colored squares sampled from the item sprite) fall each "bite" tick
   (bite every 4th game tick = 200 ms, matching vanilla sound cadence).
3. Sound: `eat1..3.ogg` randomized every 200 ms during consume; `burp.ogg` on completion; milk =
   drink loop; chorus = teleport sound.
4. On finish: apply hunger/saturation/effects, remove from queue, slot indices shift.

### 6.4 Sounds & licensing

- **Vanilla-identical**: files `entity/generic/eat/eat1..3.ogg`, `entity/player/burp/burp.ogg`
  (also `item/chorus_fruit/teleport.ogg`, `random/level_up.ogg` if XP used). Extract from the
  streamer's own Minecraft install or a GitHub minecraft-assets mirror. **These are Mojang
  copyrighted assets — same standing as the item/HUD PNGs already in `assets/`.** Mojang's usage
  guidelines tolerate fan content/overlays; do not sell the asset pack. Keep sounds in
  `assets/sounds/` and note the license caveat.
- **Fully-safe alternative (CC)**: freesoundslibrary.com "Minecraft Eating Sound" (CC-BY 4.0),
  Pixabay "minecraft eating" SFX, OpenGameArt burp packs (CC-BY-SA 4.0), Freesound "Game Eat Sound"
  (CC0). Attribution file recommended if CC-BY used.
- OBS browser sources **autoplay audio fine** (CEF ignores autoplay policy). Route audio via
  OBS "Control audio via OBS" if the streamer wants it on a separate track (eat sounds can be loud
  on stream — make volume a config).

### 6.5 Font

Any number/text (XP level, effect timers) in vanilla look: **Monocraft** (free, SIL-OFL 1.1,
github.com/IdreesInc/Monocraft) or embed as woff2. Fallback: monospace + pixelated shadow.
(Official Mojang font "Mojangles" is not redistributable.)

---

## 7. Streamer.bot integration (the middleman)

### 7.1 Connection facts (verified docs)

- Built-in **WebSocket Server**: default `ws://127.0.0.1:8080/`, endpoint `/`, optional password
  (settings → Servers/Clients → WebSocket Server). Enable events for clients in the same dialog.
- Official JS client for the widget (CDN, no build step):
  `<script src="https://cdn.jsdelivr.net/npm/@streamerbot/client/dist/streamerbot-client.js"></script>`
  → `new StreamerbotClient({ host:'127.0.0.1', port:8080, endpoint:'/', password })`.
  (For a fully-offline widget, inline the ~10 KB client or use raw `new WebSocket()`.)
- Events are **not** sent until subscribed: `client.on('Twitch.RewardRedemption', ({event, data}) => {...})`
  auto-subscribes; raw protocol: `{"request":"Subscribe","id":"<id>","events":{"Twitch":["RewardRedemption"]}}`.

### 7.2 Redemption event payload (what the widget receives)

`Twitch.RewardRedemption` (schema verified against docs.streamer.bot):

```json
{
  "timeStamp": "…",
  "event": { "source": "Twitch", "type": "RewardRedemption" },
  "data": {
    "redemptionId": "…",
    "reward": { "id": "…", "title": "Eat a Steak", "cost": 500, "prompt": "…", "requiresUserInput": false, "globalCooldown": 60, "maxPerStream": 0, "maxPerUserPerStream": 10 },
    "user":   { "id": "…", "login": "viewer", "name": "Viewer" },
    "status": "unfulfilled",
    "userInput": null,
    "createdAt": "…", "isTest": false, "counter": 53
  }
}
```

Mapping: `data.reward.title` (or `reward.id`) → `food_id` (config table from the spreadsheet,
baked into the widget or fetched via `GetActions`/`GetGlobal`). `requiresUserInput` unused.

### 7.3 Refunds — the critical caveat

- Sub-action **`Twitch → Rewards → Update Redemption Status`** (`Fulfilled` / `Cancel` = refund)
  and C# `CPH.TwitchRedemptionFulfill(...)` exist. **They only work for rewards created/owned by
  Streamer.bot** ("A redeem must be originally created by Streamer.bot for this sub-action to
  work" — docs FAQ). So the setup steps must create the 42 rewards through Streamer.bot
  (Platforms → Twitch → Channel Point Rewards → import/create), not manually in the Twitch dashboard.
- Refund flow: queue full / item disabled / engine rejects → widget calls
  `client.doAction({name:'MC Refund'}, { redemptionId, rewardId })`; Streamer.bot action contains the
  Update-Redemption-Status sub-action (Status = Cancel) → points returned, redemption leaves the queue.
  Optionally a chat notice sub-action ("@user queue is full — refunded").
- Twitch hard-limits (verified): **max 50 custom rewards per channel** (enabled+disabled) — 42 foods
  fits, but the streamer must prune other rewards; per-reward cooldown min 60 s max 7 d;
  per-user/per-stream caps available as Twitch-side anti-spam backstop (engine queue + cooldown are
  the primary throttle).

### 7.4 Streamer.bot setup checklist (one-time)

1. Connect Twitch account (EventSub; 1.0.x uses EventSub for everything — no IRC needed).
2. Create/import the 42 food rewards via Streamer.bot (owned ⇒ refundable). Titles per `channel_points` sheet.
3. WebSocket Server: port 8080, password set, "Allow all events" (or whitelist `Twitch.RewardRedemption`).
4. One Action `MC Refund` = [Update Redemption Status → Cancel] reading `%redemptionId%`/`%rewardId%` args.
5. Optional Action `MC Command` = chat notice on refund / level-up announcements
   (`CPH.Send Twitch message` or Trigger Custom Event).
6. Widget URL param carries host/port/password (`index.html?host=…&port=…&pw=…&scale=3`).

---

## 8. OBS deployment notes

- Source type: **Browser**, local file `index.html` (or `http://127.0.0.1` if dev-serving),
  width/height = canvas (1920×1080), FPS 60, "Custom CSS" empty; transparency works out of the box
  (page background transparent).
- Checkbox **"Shutdown source when not visible" must be OFF** (else game state resets when switching
  scenes; widget should also persist state to `localStorage` as crash insurance — CEF keeps
  localStorage per source).
- Audio: works automatically; toggle "Control audio via OBS" to route to its own mixer channel.
- Refresh cache of the source after asset updates.
- Performance trivial (one DOM canvas/CSS animation loop, 20 tps logic decoupled via
  accumulator; `requestAnimationFrame` for rendering).

---

## 9. Engine implementation notes (for the plan)

- **Fixed timestep 50 ms** (20 tps, Minecraft-identical) via accumulator; render at rAF.
- State object: `{hp, maxHp:20, hunger, saturation, exhaustion, absorption:{points,until},
  effects:[{id,lvl,until}], queue:[foodId×9], eating:{slot,startedAt,duration}, xp:{level,progress},
  death:{until}|null}`.
- Ticks: apply exhaustion sources (activity profile + active Hunger effect + regen costs) →
  drain saturation/hunger → regen/starve timers → DoT effects (poison/wither interval math above)
  → absorption expiry → eating progress → XP.
- Effect stacking rule (vanilla): same effect re-applied = **longer duration wins, higher level
  wins** (no downgrades, no stacking beyond that).
- Damage flash: on any HP loss, overlay `hp_bar_white.png` ~0.5 s + slight HUD shake;
  hearts also jitter when HP ≤ 4 (vanilla low-health shake).
- Randomness: effect chances per item (30/60/80%); suspicious stew pool; chorus teleport particles.
- Persistence: `localStorage` snapshot on every state change; optional sync to Streamer.bot global
  (`Set Global Variable` via a `MC State` action) if the streamer wants a chat bot to read state.
- Tests: unit-test the food tick math against the table in §3 (regen cost 6, saturation boost 1.5,
  exhaustion unit 4) — these are the numbers most often gotten wrong.

## 10. Open questions for the streamer (decide before/during build)

1. **Activity profile** default (relaxed/normal/hardcore) and whether it's switchable via a channel point reward ("Risk Mode").
2. **XP meaning**: channel-points→XP (proposed) vs survival timer vs pure cosmetic.
3. **Death**: respawn timer 10 s? XP penalty? refund queued items or keep?
4. **Skip-ahead vs strict FIFO** when head item's gates are unmet (recommended: skip-ahead).
5. **Hazard balance**: are grief foods (pufferfish, rotten flesh) allowed at low cost? (drives whether golden apples ever get bought).
6. Channel **50-reward cap**: confirm other existing rewards can be pruned.
7. Sounds: extracted vanilla (Mojang assets, private use) vs CC-safe pack.
8. Does the widget also react to follows/subs/raids (bonus HP events)? Not in current spec — could be phase 2.

## 11. Sources (primary)

- Food/saturation/eating/exhaustion tables: minecraft.wiki/w/Food (incl. saturation list, effect list, exhaustion table)
- Hunger mechanics & regen: minecraft.wiki/w/Hunger_(effect), /w/Healing, /w/Health, /w/Tutorial:Hunger_management; HungerConstants (Fabric yarn javadoc: EXHAUSTION_PER_HITPOINT=6, UNIT=4.0, INITIAL_SATURATION=5.0)
- Effect mechanics: minecraft.wiki/w/Poison, /w/Wither_(effect), /w/Regeneration, /w/Absorption, /w/Strength, /w/Weakness, /w/Saturation_(effect), /w/Instant_Health, /w/Instant_Damage, /w/Effect (HUD layout/colors), /w/Effect_colors
- XP: minecraft.wiki/w/Experience (level curve, level 30 = 1395 XP)
- Jump Boost: minecraft.wiki/w/Jump_Boost (1.83 / 2.52 blocks)
- Sounds: minecraft.wiki/w/Template:Sound_table/Entity/Food/JE (`entity.generic.eat` eat1–3, `entity.player.burp`), /w/Sounds.json/Java_Edition_values; CC alternatives: freesoundslibrary.com (CC-BY), pixabay.com/sound-effects (Pixabay license), opengameart.org "Burps" (CC-BY-SA)
- Streamer.bot: docs.streamer.bot — /api/websocket/guide/configuration (port 8080, auth), /api/websocket/requests (Subscribe/DoAction), /api/websocket/events/twitch/reward-redemption (payload schema), /api/sub-actions/twitch/rewards/update-redemption-status (Fulfilled/Cancel), /faq/fulfill-cancel-cpr (ownership requirement), /api/csharp/methods/twitch/channel-reward/twitch-redemption-fulfill; @streamerbot/client (streamerbot.github.io/client — CDN install, .on(), doAction, custom events)
- Twitch: help.twitch.tv Channel Points FAQ/Guide (50 custom rewards cap, cooldowns 1 min–7 d, per-stream/per-user caps)
- OBS: obsproject.com/kb/browser-source; obs-browser docs (config, autoplay)
- Font: github.com/IdreesInc/Monocraft (SIL OFL 1.1)
- Eating animation reference: vanilla Java = particles+sounds only (mojira MC-229024), Bedrock has 3rd-person anim; community "Eating Animation" mod for sprite-stage reference
