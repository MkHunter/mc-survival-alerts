/* engine.js — pure 20-tps Minecraft survival simulation. Zero DOM, zero timers.
 * Works in browser (window.MCEngine) and node (module.exports) for tests.
 * All constants come from game-data (GAME_DATA.config) via cfg overrides.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.MCEngine = mod;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // --- deterministic rng (mulberry32) ---
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const PROFILES = { idle: 0, relaxed: 3, normal: 6, hardcore: 12 }; // exhaustion per minute

  const DEFAULTS = {
    'engine.tick_rate_ms': 50,
    'engine.max_hunger': 20,
    'engine.max_health': 20,
    'engine.initial_health': 20,
    'engine.initial_hunger': 20,
    'engine.initial_saturation': 5.0,
    'engine.exhaustion_unit': 4.0,
    'engine.regen_interval_s': 4.0,
    'engine.saturation_boost_interval_s': 0.5,
    'engine.starve_interval_s': 4.0,
    'sim.activity_profile': 'normal',
    'queue.size': 9,
    'queue.block_strict': 'False',
    'xp.divisor': 10,
    'death.respawn_s': 10,
    'death.clear_effects': 'true',
    'death.xp_penalty': 'halve_level',
    'eat.bite_interval_ms': 200,
    'persistence.localstorage_key': 'mc_hud_state_v1',
  };

  function cfgGet(cfg, key) {
    const v = (cfg && key in cfg) ? cfg[key] : DEFAULTS[key];
    return v;
  }
  function num(cfg, key) { return Number(cfgGet(cfg, key)); }
  function bool(cfg, key) {
    const v = cfgGet(cfg, key);
    return v === true || v === 'true' || v === 'True' || v === 1 || v === '1';
  }

  // xp needed to go from level L to L+1 (vanilla)
  function xpForNext(level) {
    if (level < 16) return 2 * level + 7;
    if (level < 31) return 5 * level - 38;
    return 9 * level - 158;
  }
  // cumulative xp required to be AT level L (progress 0)
  function xpAtLevelStart(level) {
    let total = 0;
    for (let l = 0; l < level; l++) total += xpForNext(l);
    return total;
  }
  function levelFromTotal(total) {
    let level = 0, rem = total;
    while (rem >= xpForNext(level)) { rem -= xpForNext(level); level++; }
    return { level, progress: level >= 0 ? rem / xpForNext(level) : 0, intoLevel: rem };
  }

  // parse "max(1, 50>>amp)" -> base 50 ; "0.005*(amp+1)" -> 0.005 ; "+4*2^amp" -> {mult:4,pow:true}
  function parseLeadingNumber(s) {
    const m = /(-?\d+(?:\.\d+)?)/.exec(String(s || ''));
    return m ? Number(m[1]) : 0;
  }

  function create(data, cfg, opts) {
    opts = opts || {};
    const rng = opts.rng || mulberry32(opts.seed != null ? opts.seed : 1337);
    const emit = opts.emit || function () {};

    const items = {};
    for (const it of data.items) items[it.id] = it;
    const effects = data.effects; // dict keyed by id
    const rewardsByTitle = {};
    for (const r of data.rewards) rewardsByTitle[String(r.title).trim().toLowerCase()] = r;
    const rewards = data.rewards;

    const TICK = num(cfg, 'engine.tick_rate_ms');
    const MAX_HP = num(cfg, 'engine.max_health');
    const MAX_HUNGER = num(cfg, 'engine.max_hunger');
    const EXH_UNIT = num(cfg, 'engine.exhaustion_unit');
    const QUEUE_MAX = num(cfg, 'queue.size');
    const BLOCK_STRICT = bool(cfg, 'queue.block_strict');
    const BITE_MS = num(cfg, 'eat.bite_interval_ms');
    const RESPAWN_MS = num(cfg, 'death.respawn_s') * 1000;
    const XP_DIVISOR = num(cfg, 'xp.divisor');

    function exhaustionPerTick() {
      const prof = String(cfgGet(cfg, 'sim.activity_profile')).toLowerCase();
      return (PROFILES[prof] != null ? PROFILES[prof] : PROFILES.normal) / 1200;
    }

    function freshState(t0) {
      return {
        t: t0 || 0,
        hp: num(cfg, 'engine.initial_health'),
        maxHp: MAX_HP,
        hunger: num(cfg, 'engine.initial_hunger'),
        saturation: num(cfg, 'engine.initial_saturation'),
        exhaustion: 0,
        absorption: { points: 0, until: 0 },
        effects: [], // {id, level, until, nextTickAt}
        queue: [],   // {foodId, redemptionId, rewardId, user, cost}
        eating: null, // {foodId, redemptionId, rewardId, user, startedAt, durationMs, nextBiteAt, bitesDone}
        xp: { total: 0, level: 0, progress: 0 },
        death: null, // {until}
        regenTimers: { slow: 0, fast: 0, starve: 0 },
        seenRedemptions: [],
        stats: { consumed: 0, refunded: 0, deaths: 0 },
      };
    }

    const state = freshState(0);

    // ---------- helpers ----------
    function hasEffect(id) { return state.effects.find(e => e.id === id) || null; }
    function effectLevel(id) { const e = hasEffect(id); return e ? e.level : 0; }

    function addEffect(id, level, durationMs) {
      const def = effects[id] || {};
      // instant saturation: no icon, immediate hunger/sat (vanilla)
      if (id === 'saturation') {
        state.hunger = Math.min(MAX_HUNGER, state.hunger + 1 * level);
        state.saturation = Math.min(state.hunger, state.saturation + 2 * level);
        return;
      }
      if (id === 'instant_health') {
        state.hp = Math.min(state.maxHp, state.hp + 4 * Math.pow(2, level - 1));
        return;
      }
      if (id === 'instant_damage') {
        damage(6 * Math.pow(2, level - 1), 'magic', 0);
        return;
      }
      if (id === 'absorption') {
        state.absorption.points = Math.min(20, state.absorption.points + 4 * level);
        state.absorption.until = state.t + durationMs;
      }
      const existing = hasEffect(id);
      const until = state.t + durationMs;
      if (existing) {
        // stacking rule: duration longer wins, level higher wins; never downgrade
        const keepLevel = Math.max(existing.level, level);
        const keepUntil = Math.max(existing.until, until);
        if (keepLevel !== existing.level || keepUntil !== existing.until) {
          existing.level = keepLevel;
          existing.until = keepUntil;
          existing.nextTickAt = nextDotTick(existing);
        }
        return existing;
      }
      const e = { id, level, until, nextTickAt: 0 };
      e.nextTickAt = nextDotTick(e);
      state.effects.push(e);
      emit('effect_added', { id, level, until, type: def.type, overlay: def.params && def.params.visual_overlay });
      return e;
    }

    function dotIntervalMs(e) {
      const def = effects[e.id] || {};
      const f = def.params && def.params.interval_ticks_formula;
      if (!f) return 0; // not a DoT
      const base = parseLeadingNumber(f); // 50 / 25 / 40
      const amp = e.level - 1;
      const ticks = Math.max(1, base >> amp);
      return ticks * TICK;
    }
    function nextDotTick(e) {
      const iv = dotIntervalMs(e);
      return iv > 0 ? state.t + iv : 0;
    }

    function removeEffect(id, reason) {
      const i = state.effects.findIndex(e => e.id === id);
      if (i >= 0) {
        const e = state.effects.splice(i, 1)[0];
        if (id === 'absorption') { state.absorption.points = 0; state.absorption.until = 0; }
        emit('effect_removed', { id, reason: reason || 'expired', overlay: effects[id] && effects[id].params && effects[id].params.visual_overlay });
      }
    }

    function clearAllEffects(reason) {
      for (const e of state.effects.slice()) removeEffect(e.id, reason || 'cleared');
      state.absorption.points = 0; state.absorption.until = 0;
    }

    // ---------- damage ----------
    function damage(amount, source, floor) {
      if (state.death) return 0;
      if (source !== 'starve') {
        const rl = effectLevel('resistance');
        if (rl > 0) amount = Math.floor(amount * Math.max(0, 1 - 0.2 * rl));
      }
      if (amount <= 0) return 0;
      const before = state.hp;
      // absorption depletes first
      if (state.absorption.points > 0) {
        const absorbed = Math.min(state.absorption.points, amount);
        state.absorption.points -= absorbed;
        amount -= absorbed;
        // 1.20.2+ rule: absorption effect removed when hearts hit 0
        if (state.absorption.points <= 0 && hasEffect('absorption')) removeEffect('absorption', 'depleted');
      }
      state.hp = Math.max(floor, state.hp - amount);
      const lost = before - state.hp;
      if (lost > 0 || state.hp <= 0) emit('damage', { amount: before - state.hp, source, hp: state.hp });
      if (state.hp <= 0 && !state.death) die();
      return lost;
    }

    function die() {
      if (bool(cfg, 'death.clear_effects')) clearAllEffects('death');
      state.absorption.points = 0; state.absorption.until = 0;
      state.hp = 0;
      // cancel any in-progress eat; item stays in queue
      if (state.eating) state.eating = null;
      // xp penalty
      if (String(cfgGet(cfg, 'death.xp_penalty')) === 'halve_level') {
        const newLevel = Math.floor(state.xp.level / 2);
        state.xp.total = xpAtLevelStart(newLevel);
        const r = levelFromTotal(state.xp.total);
        state.xp.level = r.level; state.xp.progress = r.progress;
      } else if (String(cfgGet(cfg, 'death.xp_penalty')) === 'reset') {
        state.xp = { total: 0, level: 0, progress: 0 };
      }
      state.death = { until: state.t + RESPAWN_MS };
      state.stats.deaths++;
      emit('death', { until: state.death.until });
    }

    function respawn() {
      state.death = null;
      state.hp = MAX_HP;
      state.hunger = MAX_HUNGER;
      state.saturation = num(cfg, 'engine.initial_saturation');
      state.exhaustion = 0;
      state.regenTimers = { slow: 0, fast: 0, starve: 0 };
      emit('respawn', {});
    }

    // ---------- xp ----------
    function addXp(amount) {
      const before = state.xp.level;
      state.xp.total += amount;
      const r = levelFromTotal(state.xp.total);
      state.xp.level = r.level; state.xp.progress = r.progress;
      if (state.xp.level > before) emit('levelup', { level: state.xp.level });
    }

    // ---------- queue / redemptions ----------
    function mapReward(input) {
      // input: {title, rewardId, foodId} -> food_id or null
      if (input.foodId && items[input.foodId]) return input.foodId;
      if (input.title) {
        const r = rewardsByTitle[String(input.title).trim().toLowerCase()];
        if (r) return r.food_id;
      }
      if (input.rewardId && cfg['rewards.id_map'] && cfg['rewards.id_map'][input.rewardId]) {
        return cfg['rewards.id_map'][input.rewardId];
      }
      return null;
    }

    function addRedemption(input) {
      // input: {title?, foodId?, rewardId?, redemptionId?, user?, cost?}
      const rid = input.redemptionId || ('local-' + Math.floor(rng() * 1e9) + '-' + state.t);
      if (state.seenRedemptions.includes(rid)) return { ok: false, reason: 'duplicate' };
      state.seenRedemptions.push(rid);
      if (state.seenRedemptions.length > 100) state.seenRedemptions.shift();

      const foodId = mapReward(input);
      if (!foodId) { emit('unknown_reward', input); return { ok: false, reason: 'unknown_reward', silent: true }; }
      const reward = rewards.find(r => r.food_id === foodId);
      const entry = {
        foodId,
        redemptionId: rid,
        rewardId: input.rewardId || (reward && reward.title) || '',
        user: input.user || 'viewer',
        cost: input.cost != null ? input.cost : (reward ? reward.cost : 0),
      };
      if (reward && reward.enabled === false) {
        emit('refund', { entry, reason: 'item_disabled' });
        state.stats.refunded++;
        return { ok: false, reason: 'item_disabled' };
      }
      if (state.death) {
        emit('refund', { entry, reason: 'player_dead' });
        state.stats.refunded++;
        return { ok: false, reason: 'player_dead' };
      }
      if (state.queue.length >= QUEUE_MAX) {
        emit('refund', { entry, reason: 'queue_full' });
        state.stats.refunded++;
        return { ok: false, reason: 'queue_full' };
      }
      state.queue.push(entry);
      addXp(entry.cost / XP_DIVISOR);
      emit('redeem_accept', { entry, slot: state.queue.length - 1 });
      return { ok: true, slot: state.queue.length - 1 };
    }

    function eligible(item) {
      if (!item) return false;
      if (!(item.can_always_eat || state.hunger < MAX_HUNGER)) return false;
      if (item.eat_when_hp_below != null && state.hp > item.eat_when_hp_below) return false;
      return true;
    }

    function pickNextIndex() {
      if (BLOCK_STRICT) return eligible(items[state.queue[0] && state.queue[0].foodId]) ? 0 : -1;
      // skip-ahead: first eligible from head
      for (let i = 0; i < state.queue.length; i++) {
        if (eligible(items[state.queue[i].foodId])) return i;
      }
      return -1;
    }

    function startEat() {
      const idx = pickNextIndex();
      if (idx < 0) return;
      const entry = state.queue[idx];
      const item = items[entry.foodId];
      state.eating = {
        queueIndex: idx,
        foodId: entry.foodId,
        redemptionId: entry.redemptionId,
        rewardId: entry.rewardId,
        user: entry.user,
        startedAt: state.t,
        durationMs: item.consume_time_ms,
        nextBiteAt: state.t + BITE_MS,
        bitesDone: 0,
        soundProfile: item.sound_profile || 'eat',
      };
      emit('eat_start', { slot: idx, foodId: entry.foodId, durationMs: item.consume_time_ms, soundProfile: state.eating.soundProfile });
    }

    function finishEat() {
      const eating = state.eating;
      const item = items[eating.foodId];
      // remove from queue (index may have shifted? queue is append-only during eat, head-stable)
      const qi = state.queue.findIndex(q => q.redemptionId === eating.redemptionId);
      if (qi >= 0) state.queue.splice(qi, 1);
      state.eating = null;

      state.hunger = Math.min(MAX_HUNGER, state.hunger + item.hunger);
      state.saturation = Math.min(state.hunger, state.saturation + item.saturation); // cap rule

      // rolls
      for (const eff of item.effects || []) {
        const pct = eff.chance_pct != null ? eff.chance_pct : 100;
        if (rng() * 100 < pct) addEffect(eff.id, eff.level, eff.duration_ms);
      }
      if (item.stew_pool && item.stew_pool.length) {
        const pick = item.stew_pool[Math.floor(rng() * item.stew_pool.length)];
        addEffect(pick.id, pick.level, pick.duration_ms);
      }
      if (item.clears_effects === 'all') clearAllEffects('milk');
      else if (item.clears_effects === 'poison') removeEffect('poison', 'honey');

      state.stats.consumed++;
      emit('consume', { item, entry: eating });
      if (item.teleport_fx) emit('teleport', { foodId: item.id });
      emit('burp', {});
      emit('fulfill', { entry: eating });
    }

    // ---------- tick ----------
    function tick(dtMs) {
      const dt = dtMs || TICK;
      state.t += dt;

      // 1. death countdown
      if (state.death) {
        if (state.t >= state.death.until) respawn();
        return;
      }

      // 2. exhaustion: activity + hunger effect
      state.exhaustion += exhaustionPerTick() * (dt / TICK);
      const hungerLvl = effectLevel('hunger');
      if (hungerLvl > 0) state.exhaustion += 0.005 * hungerLvl * (dt / TICK);

      // 3. drain
      while (state.exhaustion >= EXH_UNIT) {
        state.exhaustion -= EXH_UNIT;
        if (state.saturation > 0) state.saturation = Math.max(0, state.saturation - 1);
        else if (state.hunger > 0) state.hunger--;
      }

      // 4. regen
      if (state.hp < state.maxHp) {
        if (state.hunger >= 20 && state.saturation > 0) {
          state.regenTimers.fast += dt;
          state.regenTimers.slow = 0;
          while (state.regenTimers.fast >= num(cfg, 'engine.saturation_boost_interval_s') * 1000) {
            state.regenTimers.fast -= num(cfg, 'engine.saturation_boost_interval_s') * 1000;
            state.hp = Math.min(state.maxHp, state.hp + 1);
            state.exhaustion += 1.5;
            emit('heal', { hp: state.hp, kind: 'fast' });
          }
        } else if (state.hunger >= 18) {
          state.regenTimers.slow += dt;
          state.regenTimers.fast = 0;
          while (state.regenTimers.slow >= num(cfg, 'engine.regen_interval_s') * 1000) {
            state.regenTimers.slow -= num(cfg, 'engine.regen_interval_s') * 1000;
            state.hp = Math.min(state.maxHp, state.hp + 1);
            state.exhaustion += 6;
            emit('heal', { hp: state.hp, kind: 'slow' });
          }
        } else {
          state.regenTimers.slow = 0; state.regenTimers.fast = 0;
        }
      } else {
        state.regenTimers.slow = 0; state.regenTimers.fast = 0;
      }

      // 5. starvation
      if (state.hunger <= 0) {
        state.regenTimers.starve += dt;
        while (state.regenTimers.starve >= num(cfg, 'engine.starve_interval_s') * 1000) {
          state.regenTimers.starve -= num(cfg, 'engine.starve_interval_s') * 1000;
          damage(1, 'starve', 1);
          if (state.death) return;
        }
      } else {
        state.regenTimers.starve = 0;
      }

      // 6. effect DoT
      for (const e of state.effects.slice()) {
        if (!e.nextTickAt) continue;
        while (e.nextTickAt && state.t >= e.nextTickAt) {
          const def = effects[e.id] || {};
          const hpChange = parseLeadingNumber(def.params && def.params.hp_change_per_interval);
          if (e.id === 'regeneration') {
            if (state.hp < state.maxHp) { state.hp = Math.min(state.maxHp, state.hp + Math.max(1, hpChange)); emit('heal', { hp: state.hp, kind: 'regen' }); }
          } else if (hpChange < 0) {
            const canKill = String(def.params && def.params.can_kill || '').startsWith('yes');
            damage(-hpChange, e.id, canKill ? 0 : 1);
            if (state.death) return;
          }
          e.nextTickAt += dotIntervalMs(e);
          if (state.t < e.nextTickAt) break;
        }
      }

      // 7. expirations
      for (const e of state.effects.slice()) {
        if (state.t >= e.until) {
          if (e.id === 'absorption') { /* handled in removeEffect */ }
          removeEffect(e.id, 'expired');
        }
      }
      if (state.absorption.points > 0 && state.absorption.until && state.t >= state.absorption.until) {
        state.absorption.points = 0;
        if (hasEffect('absorption')) removeEffect('absorption', 'expired');
      }

      // 8. eating
      if (state.eating) {
        const e = state.eating;
        while (state.t >= e.nextBiteAt && state.t < e.startedAt + e.durationMs) {
          e.bitesDone++;
          e.nextBiteAt += BITE_MS;
          emit('bite', { foodId: e.foodId, bitesDone: e.bitesDone, soundProfile: e.soundProfile });
        }
        if (state.t >= e.startedAt + e.durationMs) finishEat();
      } else {
        startEat();
      }

      // 9. death check (from damage() calls this tick) — handled inline via die()
    }

    // ---------- phase-2 hook ----------
    function applyExternalEvent(type, payload) {
      // wired to SB custom events later (follows/subs/raids)
      emit('external_event', { type, payload });
    }

    // ---------- persistence ----------
    function serialize() {
      return JSON.stringify({ v: 1, state });
    }
    function restore(json) {
      try {
        const o = JSON.parse(json);
        if (!o || !o.state) return false;
        const s = o.state;
        // shallow sanity
        if (typeof s.hp !== 'number' || !Array.isArray(s.queue)) return false;
        Object.assign(state, s);
        if (state.eating) state.eating = null; // never resume mid-bite
        return true;
      } catch (e) { return false; }
    }

    function isEligible(foodId) { return eligible(items[foodId]); }
    function nextEatIndex() { return state.eating ? state.eating.queueIndex : pickNextIndex(); }

    return {
      state, tick, addRedemption, addEffect, damage, die, respawn, addXp,
      applyExternalEvent, serialize, restore, isEligible, nextEatIndex,
      _internals: { xpForNext, xpAtLevelStart, levelFromTotal, eligible, pickNextIndex, dotIntervalMs, items, effects, rewards },
      constants: { TICK, MAX_HP, MAX_HUNGER, EXH_UNIT, QUEUE_MAX, BITE_MS, RESPAWN_MS },
    };
  }

  return { create, mulberry32, xpForNext, xpAtLevelStart, levelFromTotal, PROFILES };
});
