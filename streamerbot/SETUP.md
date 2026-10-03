# Streamer.bot setup — MC Survival HUD

One-time checklist. ~15 min.

## 1. Connect Twitch
Streamer.bot → Platforms → Twitch → connect broadcaster account (EventSub is automatic in 0.2.x).

## 2. Create channel-point rewards IN Streamer.bot
**Critical:** refunds only work for rewards **created/owned by Streamer.bot**. Rewards made on
twitch.tv cannot be refunded (points will silently not return).

Platforms → Twitch → Channel Point Rewards → Add, one per enabled food.
Titles, costs, cooldowns: copy from `data/game-data.json → rewards[]`
(or the `channel_points` sheet). **Titles must match exactly** — the widget maps by title.

Phase A: the ~20 rows with `enabled: true`. Twitch caps custom rewards at 50 total —
prune old rewards before enabling Phase B (all 42).

Quick list (check game-data.json for current values):

```
node -e "const d=require('./data/game-data.json'); d.rewards.filter(r=>r.enabled).forEach(r=>console.log(r.title+' | '+r.cost+' | cd '+r.cooldown_s+'s'))"
```

## 3. WebSocket server
Settings → WebSocket Server → enable, port **8080**, set a **password**.
Allow events: at minimum `Twitch.RewardRedemption`.

## 4. Actions: MC Fulfill + MC Refund
Create two actions (exact names — widget reads them from `simulation_config`):

**`MC Fulfill`** (marks redemption complete after the food is eaten)
- Sub-action: Twitch → Rewards → **Update Redemption Status** → Status: `Fulfilled`,
  Redemption Id: `%redemptionId%`
- Optional chat: `🍜 %user%'s %foodId% was devoured!`

**`MC Refund`** (returns points when the widget rejects a redemption)
- Sub-action: Twitch → Rewards → **Update Redemption Status** → Status: `Cancel`,
  Redemption Id: `%redemptionId%`
- Optional chat: `@%user% — %reason%, points refunded`

Both take their IDs from action args (`%redemptionId%` etc.) — the widget passes them
via `DoAction` args.

> `streamerbot/import/mc-actions.json` is a **draft** import template. Import formats
> drift between SB releases: export one action you created by hand, diff the schema,
> fix GUIDs/keys in the template, then import. Clicking the two actions together
> manually (~2 min) is the safer path.

## 5. OBS source
- Add → Browser → **Local file**: `src/index.html` — width 1920, height 1080, FPS 60.
- Custom CSS field: **empty** (page is already transparent).
- URL params go on the local-file path:
  `.../src/index.html?host=127.0.0.1&port=8080&pw=<ws password>&scale=3&profile=normal`
- **OFF**: "Shutdown source when not visible" · **OFF**: "Refresh browser when scene
  becomes active" (else the game resets on scene switches).
- Audio: tick "Control audio via OBS" for a dedicated eat/burp mixer channel.

## 6. Sanity test
1. Open the same URL in a browser with `&mock=1` appended — debug panel appears.
2. Redeem the cheapest real reward on your Twitch page → item appears in hotbar < 1 s.
3. Watch it eat, hear the burp → redemption shows **Fulfilled** on the Twitch dashboard.
4. In the mock panel: redeem 9 items to fill the queue, then redeem once more →
   that redemption is **Canceled** (points returned) with reason `queue_full`.

## URL params
| param | default | meaning |
|---|---|---|
| `host` / `port` / `pw` | 127.0.0.1 / 8080 / — | Streamer.bot WS |
| `scale` | 3 | GUI pixel scale |
| `profile` | normal | `idle\|relaxed\|normal\|hardcore` (exhaustion/min 0/3/6/12) |
| `volume` | 0.8 | master SFX volume |
| `timescale` | 1 | tick multiplier (testing) |
| `mock` | 0 | debug panel |
| `fresh` | 0 | ignore saved state |

Everything else (food values, gates, costs, death rules…) lives in
`minecraft_survival_alerts.ods` — edit, then run `python3 tools/ods_to_json.py` and
refresh the OBS source.
