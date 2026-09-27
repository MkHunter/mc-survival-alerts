/* engine.test.js — node, zero deps. Run: node tests/engine.test.js
 * Golden numbers from implementation-plan.md §11.1 (wiki-verified).
 */
'use strict';
const path = require('path');
const fs = require('fs');

// load game-data.json + engine without a browser
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'game-data.json'), 'utf8'));
const MCEngine = require(path.join(__dirname, '..', 'src', 'js', 'engine.js'));

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; }
  else { failed++; failures.push(name + (extra !== undefined ? ' — got ' + JSON.stringify(extra) : '')); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }
function eq(a, b, name) { ok(approx(a, b), name + ` (want ${b})`, a); }
function seq(a, b, name) { ok(a === b, name + ` (want ${b})`, a); }

function mk(cfgOver, seed) {
  const cfg = Object.assign({}, data.config, cfgOver || {});
  const events = [];
  const eng = MCEngine.create(data, cfg, {
    seed: seed != null ? seed : 42,
    emit: (type, payload) => events.push({ type, payload }),
  });
  return { eng, events };
}
function run(eng, ms) { for (let i = 0; i < Math.round(ms / 50); i++) eng.tick(50); }
function count(events, type) { return events.filter(e => e.type === type).length; }

// ---------- 1. exhaustion unit ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.saturation = 5; eng.state.exhaustion = 3.95;
  run(eng, 50);
  // idle adds 0 exhaustion; manually push over the unit
  eng.state.exhaustion = 4.0; eng.tick(50);
  eq(eng.state.saturation, 4, 'exhaustion unit drains 1 saturation');
  eq(eng.state.exhaustion, 0, 'exhaustion resets after drain');
  eng.state.saturation = 0; eng.state.exhaustion = 4.0; eng.tick(50);
  eq(eng.state.hunger, 19, 'sat 0 -> drains hunger');
}

// ---------- 2. activity normal: 1 point / 40s, 1.5 pts/min ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'normal' });
  eng.state.saturation = 0; eng.state.hunger = 20; eng.state.hp = 20; // isolate drain
  run(eng, 41000);
  eq(eng.state.hunger, 19, 'normal profile: 1 hunger point per 40 s');
}

// ---------- 3. slow regen: +1 HP / 4s, +6 exhaustion ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.hunger = 18; eng.state.saturation = 0; eng.state.hp = 15;
  run(eng, 4000);
  eq(eng.state.hp, 16, 'slow regen heals 1 HP per 4 s');
  eq(eng.state.exhaustion, 6, 'slow regen adds 6 exhaustion per heal');
}

// ---------- 4. fast regen: +1 HP / 0.5s, +1.5 exhaustion; stops at sat 0 ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.hunger = 20; eng.state.saturation = 5; eng.state.hp = 10;
  run(eng, 500);
  eq(eng.state.hp, 11, 'fast regen heals 1 HP per 0.5 s');
  eq(eng.state.exhaustion, 1.5, 'fast regen adds 1.5 exhaustion per heal');
  // burn saturation: each heal adds 1.5 ex; 5 sat = 20 ex. At hp 10, fast heals
  // 4 HP per 2s (6 ex) + drain 1 sat per 4 ex... verify it stops at sat 0:
  const m2 = mk({ 'sim.activity_profile': 'idle' });
  m2.eng.state.hunger = 20; m2.eng.state.saturation = 1; m2.eng.state.hp = 10;
  run(m2.eng, 2000);
  const fastHeals = m2.events.filter(e => e.type === 'heal' && e.payload.kind === 'fast').length;
  ok(m2.eng.state.saturation === 0 && fastHeals <= 3, 'fast regen stops when saturation hits 0', { fastHeals, sat: m2.eng.state.saturation });
}

// ---------- 5. starve: 1 HP / 4s, floor 1 ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.hunger = 0; eng.state.saturation = 0; eng.state.hp = 10;
  run(eng, 40000);
  eq(eng.state.hp, 1, 'starvation floors at 1 HP (Normal)');
  ok(!eng.state.death, 'starvation never kills');
}

// ---------- 6. poison II: 1 HP / 0.6s, floor 1 ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.hp = 10; eng.state.saturation = 0; eng.state.hunger = 20;
  eng.addEffect('poison', 2, 60000);
  run(eng, 6000);
  // 25>>1 = 12 ticks = 600 ms -> 10 damage in 6 s
  eq(eng.state.hp, 1, 'poison II ticks 1 HP / 0.6 s, floored at 1');
  ok(!eng.state.death, 'poison cannot kill');
}

// ---------- 7. wither II: 1 HP / 1.0s, kills ----------
{
  const { eng, events } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.hp = 5; eng.state.saturation = 0;
  eng.addEffect('wither', 2, 60000);
  run(eng, 10000);
  // 40>>1 = 20 ticks = 1.0 s -> dead after ~5 s
  eq(eng.state.hp, 0, 'wither II kills');
  ok(count(events, 'death') === 1, 'death event fired once');
  ok(eng.state.death && eng.state.death.until > 0, 'death timer set');
  run(eng, 10000);
  eq(eng.state.hp, 20, 'respawn after 10 s restores HP');
  eq(eng.state.hunger, 20, 'respawn restores hunger');
  eq(eng.state.effects.length, 0, 'respawn effects cleared');
}

// ---------- 8. pufferfish: nausea 15s + hunger III 15s + poison II 60s; hunger III = 4.5 ex total ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  const pf = data.items.find(i => i.id === 'fish_pufferfish_raw');
  ok(!!pf, 'pufferfish item exists');
  // feed directly: force hunger space
  eng.state.hunger = 10; eng.state.saturation = 0; eng.state.hp = 20;
  const r = eng.addRedemption({ foodId: 'fish_pufferfish_raw', cost: 100 });
  ok(r.ok, 'pufferfish redemption accepted');
  run(eng, pf.consume_time_ms + 100); // eat starts at first tick, finishes at 50+1600
  const ids = eng.state.effects.map(e => e.id).sort();
  ok(ids.includes('nausea') && ids.includes('hunger') && ids.includes('poison'), 'pufferfish applies nausea+hunger+poison', ids);
  const hunger = eng.state.effects.find(e => e.id === 'hunger');
  const poison = eng.state.effects.find(e => e.id === 'poison');
  const nausea = eng.state.effects.find(e => e.id === 'nausea');
  eq(hunger.level, 3, 'pufferfish hunger level III');
  eq(poison.level, 2, 'pufferfish poison level II');
  ok(nausea.until - eng.state.t > 14800 && nausea.until - eng.state.t <= 15000, 'nausea duration 15 s', nausea.until - eng.state.t);
  // hunger III exhaustion: 0.015/tick * 20 tps * 15 s = 4.5
  const eng2 = mk({ 'sim.activity_profile': 'idle' }).eng;
  eng2.state.hp = 20; eng2.state.saturation = 0; eng2.state.hunger = 10;
  eng2.addEffect('hunger', 3, 15000);
  const sat0 = eng2.state.saturation, hun0 = eng2.state.hunger;
  run(eng2, 15000);
  const drainedEx = ((sat0 - eng2.state.saturation) + (hun0 - eng2.state.hunger)) * 4.0 + eng2.state.exhaustion;
  ok(approx(drainedEx, 4.5, 0.001), 'hunger III adds 4.5 exhaustion over 15 s', drainedEx);
}

// ---------- 9. rotten flesh 80%: seeded rng applies hunger I 30s, other seed skips ----------
{
  let applied = 0, skipped = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { eng } = mk({ 'sim.activity_profile': 'idle' }, seed);
    eng.state.hunger = 10; eng.state.saturation = 0;
    eng.addRedemption({ foodId: 'rotten_flesh', cost: 100 });
    run(eng, 1700);
    if (eng.state.effects.some(e => e.id === 'hunger')) applied++; else skipped++;
  }
  ok(applied > 0 && skipped > 0, 'rotten flesh 80% roll varies by seed', { applied, skipped });
  ok(applied >= 12 && applied <= 20, 'rotten flesh ~80% hit rate over 20 seeds', applied);
}

// ---------- 10. golden apple gates ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.hunger = 20; eng.state.saturation = 5; eng.state.hp = 20;
  eng.addRedemption({ foodId: 'apple_golden', cost: 500 });
  run(eng, 5000);
  eq(eng.state.queue.length, 1, 'golden apple waits at full HP (gate 14)');
  eng.state.hp = 14;
  run(eng, 1700);
  eq(eng.state.queue.length, 0, 'golden apple eats at HP 14');
  ok(eng.state.absorption.points === 4, 'golden apple grants 4 absorption hearts', eng.state.absorption.points);
}

// ---------- 11. skip-ahead ----------
{
  const { eng, events } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.hunger = 20; eng.state.saturation = 5; eng.state.hp = 20;
  eng.addRedemption({ foodId: 'steak', cost: 100 });        // blocked (hunger full)
  eng.addRedemption({ foodId: 'chorus_fruit', cost: 150 }); // can_always_eat
  run(eng, 1700);
  const consumed = events.find(e => e.type === 'consume');
  ok(consumed && consumed.payload.item.id === 'chorus_fruit', 'skip-ahead eats chorus before blocked steak');
  eq(eng.state.queue.length, 1, 'steak still queued');
  seq(eng.state.queue[0] && eng.state.queue[0].foodId, 'steak', 'order preserved');
}

// ---------- 12. stacking: never downgrade ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  eng.addEffect('regeneration', 2, 5000);
  eng.addEffect('regeneration', 1, 8000);
  const e = eng.state.effects.find(x => x.id === 'regeneration');
  eq(e.level, 2, 'regen level stays II (higher wins)');
  eq(e.until - eng.state.t, 8000, 'regen duration 8 s (longer wins)');
}

// ---------- 13. milk / honey ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  eng.addEffect('poison', 1, 30000);
  eng.addEffect('regeneration', 1, 30000);
  eng.state.hunger = 10;
  eng.addRedemption({ foodId: 'honey_bottle', cost: 250 });
  run(eng, 2150);
  ok(!eng.state.effects.some(e => e.id === 'poison'), 'honey clears poison');
  ok(eng.state.effects.some(e => e.id === 'regeneration'), 'honey keeps regen');
  const eng2 = mk({ 'sim.activity_profile': 'idle' }).eng;
  eng2.addEffect('poison', 1, 30000);
  eng2.addEffect('regeneration', 1, 30000);
  eng2.state.hunger = 10;
  eng2.addRedemption({ foodId: 'bucket_milk', cost: 300 });
  run(eng2, 1750);
  eq(eng2.state.effects.length, 0, 'milk clears all effects');
}

// ---------- 14. suspicious stew pool: 9-way uniform; blindness 11 s ----------
{
  const pf = data.items.find(i => i.id === 'suspicious_stew');
  eq(pf.stew_pool.length, 9, 'stew pool has 9 entries');
  const blind = pf.stew_pool.find(e => e.id === 'blindness');
  eq(blind.duration_ms, 11000, 'stew blindness is 11 s (Java)');
  const seen = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const { eng } = mk({ 'sim.activity_profile': 'idle' }, seed);
    eng.state.hunger = 10; eng.state.saturation = 0;
    eng.addRedemption({ foodId: 'suspicious_stew', cost: 250 });
    run(eng, 1700);
    eng.state.effects.forEach(e => seen.add(e.id));
    if (eng.state.hunger < 20 || eng.state.saturation > 0) seen.add('saturation'); // instant, no icon
  }
  ok(seen.size >= 7, 'stew pool hits varied effects across seeds', [...seen]);
}

// ---------- 15. XP: cost 500 -> 50 xp -> level 4, progress 10/15 ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.death = null;
  // accept without queue side-effects concerns: directly add xp
  eng.addXp(50);
  eq(eng.state.xp.level, 4, '50 xp = level 4');
  eq(Math.round(eng.state.xp.progress * 15), 10, 'progress 10/15 toward level 5');
  // via redemption
  const { eng: eng2, events } = mk({ 'sim.activity_profile': 'idle' });
  eng2.state.hunger = 10;
  eng2.addRedemption({ foodId: 'steak', cost: 500 });
  eq(eng2.state.xp.total, 50, 'xp = cost / 10 on acceptance');
  ok(count(events, 'levelup') === 1, 'single levelup event reaching level 4');
}

// ---------- 16. death: wither kills, 10 s dead, effects cleared, queue intact, xp halved, redemptions refunded ----------
{
  const { eng, events } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.hp = 3; eng.state.hunger = 20; eng.state.saturation = 0;
  eng.addRedemption({ foodId: 'steak', cost: 100, redemptionId: 'dq1' }); // blocked: hunger full -> stays queued
  eng.addXp(xpTotalFor(5) - eng.state.xp.total); // exactly level 5
  eng.addEffect('wither', 2, 60000); // 1 HP / 1.0 s -> dead at ~3 s, before slow regen kicks in
  run(eng, 5000);
  ok(eng.state.death, 'wither II kills at 3 HP');
  eq(eng.state.effects.length, 0, 'death clears effects');
  eq(eng.state.queue.length, 1, 'queue kept through death');
  eq(eng.state.xp.level, 2, 'xp level halved 5 -> 2');
  const r = eng.addRedemption({ foodId: 'steak', cost: 100 });
  ok(!r.ok && r.reason === 'player_dead', 'redemption during death refunded');
  ok(events.some(e => e.type === 'refund' && e.payload.reason === 'player_dead'), 'refund event emitted');
  run(eng, 10000);
  ok(!eng.state.death, 'respawned after 10 s');
  eq(eng.state.hp, 20, 'respawn HP 20');
}
function xpTotalFor(level) { return MCEngine.xpAtLevelStart(level); }

// ---------- 17. queue full -> refund ----------
{
  const { eng, events } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.death = { until: 0 }; eng.state.death = null; // alive
  eng.state.hp = 20; eng.state.hunger = 20; eng.state.saturation = 5;
  for (let i = 0; i < 9; i++) eng.addRedemption({ foodId: 'steak', cost: 100, redemptionId: 'r' + i });
  const r = eng.addRedemption({ foodId: 'steak', cost: 100, redemptionId: 'r10' });
  ok(!r.ok && r.reason === 'queue_full', '10th redemption rejected: queue full');
  ok(events.some(e => e.type === 'refund' && e.payload.reason === 'queue_full'), 'queue_full refund event');
}

// ---------- 18. dedupe ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.hunger = 10;
  eng.addRedemption({ foodId: 'steak', cost: 100, redemptionId: 'dup1' });
  const r = eng.addRedemption({ foodId: 'steak', cost: 100, redemptionId: 'dup1' });
  ok(!r.ok && r.reason === 'duplicate', 'duplicate redemption ignored');
  eq(eng.state.queue.length, 1, 'only one queued');
}

// ---------- 19. reward title mapping ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.hunger = 10;
  const r = eng.addRedemption({ title: '  eat a steak ', cost: 100, redemptionId: 't1' });
  ok(r.ok && eng.state.queue[0].foodId === 'steak', 'title mapped case/space-insensitive');
  const r2 = eng.addRedemption({ title: 'Some Other Reward', cost: 50, redemptionId: 't2' });
  ok(!r2.ok && r2.reason === 'unknown_reward' && r2.silent, 'unknown reward ignored silently');
}

// ---------- 20. soak: 10k ticks random ops, invariants ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'normal' }, 7);
  const foodIds = data.items.map(i => i.id);
  const rng = MCEngine.mulberry32(123);
  for (let i = 0; i < 10000; i++) {
    if (rng() < 0.05) {
      const fid = foodIds[Math.floor(rng() * foodIds.length)];
      eng.addRedemption({ foodId: fid, cost: 100, redemptionId: 'soak' + i });
    }
    eng.tick(50);
    const s = eng.state;
    const inv =
      s.hp >= 0 && s.hp <= 20 &&
      s.hunger >= 0 && s.hunger <= 20 &&
      s.saturation >= 0 && s.saturation <= s.hunger + 1e-9 &&
      s.queue.length <= 9 &&
      [s.hp, s.hunger, s.saturation, s.exhaustion, s.xp.total].every(Number.isFinite);
    if (!inv) { ok(false, 'soak invariants at tick ' + i, { hp: s.hp, hunger: s.hunger, sat: s.saturation, q: s.queue.length }); break; }
  }
  ok(true, 'soak 10k ticks invariants hold');
}

// ---------- 21. persistence round-trip ----------
{
  const { eng } = mk({ 'sim.activity_profile': 'idle' });
  eng.state.hunger = 10; eng.addRedemption({ foodId: 'steak', cost: 100, redemptionId: 'p1' });
  run(eng, 500);
  const snap = eng.serialize();
  const { eng: eng2 } = mk({ 'sim.activity_profile': 'idle' });
  ok(eng2.restore(snap), 'restore succeeds');
  eq(eng2.state.hunger, eng.state.hunger, 'hunger survives round-trip');
  eq(eng2.state.queue.length, eng.state.queue.length, 'queue survives round-trip');
  eq(eng2.state.eating, null, 'mid-bite never resumed');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.log('FAILURES:'); failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
