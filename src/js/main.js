/* main.js — bootstrap: config, engine, net, audio, ui, loop, persistence, mock panel. */
(function () {
  'use strict';

  const { cfg, opts } = MCConfig.parse(window.GAME_DATA.config);
  const data = window.GAME_DATA;
  const LS_KEY = cfg['persistence.localstorage_key'] || 'mc_hud_state_v1';
  const TICK = Number(cfg['engine.tick_rate_ms']) || 50;

  // ---- engine + event router ----
  let engine;
  function route(type, payload) {
    switch (type) {
      case 'eat_start': MCAnim.eatStart(payload, cfg); break;
      case 'bite':
        MCAudio.play(payload.soundProfile === 'drink' ? 'drink' : 'eat');
        MCAnim.bite(payload, cfg);
        break;
      case 'consume': MCAnim.eatStop(); break;
      case 'burp': MCAudio.play('burp'); break;
      case 'teleport': MCAudio.play('teleport'); MCAnim.teleport(cfg); break;
      case 'damage':
        if (!state_dead()) { MCAudio.play('hurt'); MCAnim.damageFlash(cfg); }
        break;
      case 'death': MCAudio.play('death', { rate: 0.8 }); MCAnim.eatStop(); break;
      case 'levelup': MCAudio.play('levelup'); break;
      case 'fulfill': MCNet.sendFulfill(payload.entry); break;
      case 'refund': MCNet.sendRefund(payload.entry, payload.reason); break;
      case 'effect_added': onOverlay(payload.overlay, true); break;
      case 'effect_removed': onOverlay(payload.overlay, false); break;
      case 'unknown_reward': console.warn('[MC] unknown reward ignored:', payload); break;
    }
    scheduleSave();
  }
  function state_dead() { return engine && !!engine.state.death; }

  function onOverlay(overlay, on) {
    if (overlay === 'hud_sway') MCAnim.setSway(on);
    else if (overlay === 'dark_vignette') MCAnim.setBlindness(on);
    else if (overlay === 'pulsing_dark_vignette') MCAnim.setDarkness(on);
  }

  engine = MCEngine.create(data, cfg, { seed: (Math.random() * 1e9) | 0, emit: route });

  // ---- persistence ----
  let saveTimer = 0;
  function scheduleSave() {
    const now = performance.now();
    if (now - saveTimer < 1000) return;
    saveTimer = now;
    try { localStorage.setItem(LS_KEY, engine.serialize()); } catch (e) { /* session-only fallback */ }
  }
  function loadSaved() {
    if (opts.fresh) return;
    try {
      const s = localStorage.getItem(LS_KEY);
      if (s && engine.restore(s)) {
        // re-assert overlays for restored effects
        for (const e of engine.state.effects) {
          const def = data.effects[e.id];
          if (def && def.params && def.params.visual_overlay) onOverlay(def.params.visual_overlay, true);
        }
        console.log('[MC] state restored');
      }
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('beforeunload', () => {
    try { localStorage.setItem(LS_KEY, engine.serialize()); } catch (e) {}
  });

  // ---- net ----
  MCNet.init(Object.assign({}, opts, { cfg }), {
    onRedemption(d) {
      engine.addRedemption({
        title: d.reward && d.reward.title,
        rewardId: d.reward && d.reward.id,
        redemptionId: d.redemptionId || d.id,
        user: (d.user && (d.user.name || d.user.login)) || 'viewer',
        cost: d.reward && d.reward.cost,
      });
    },
  });

  // ---- ui/audio/anim ----
  MCAudio.init(opts);
  MCUI.init({ scale: opts.scale, data, cfg });
  MCAnim.init({ scale: opts.scale, data });
  loadSaved();

  // ---- fixed-timestep loop (20 tps, timescale for testing) ----
  let last = performance.now(), acc = 0;
  function frame(nowMs) {
    let dt = (nowMs - last) * opts.timescale;
    last = nowMs;
    if (dt > 5000) dt = 5000; // tab-backlog clamp
    acc += dt;
    let n = 0;
    while (acc >= TICK && n < 400) { engine.tick(TICK); acc -= TICK; n++; }
    if (n >= 400) acc = 0;
    MCUI.render(engine.state, nowMs, engine);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- mock / dev panel ----
  if (opts.mock) buildMockPanel();

  function buildMockPanel() {
    const p = document.createElement('div');
    p.id = 'mock-panel';
    p.innerHTML = '<h3>MC MOCK</h3>';
    const row = (html) => { const d = document.createElement('div'); d.className = 'mock-row'; d.innerHTML = html; p.appendChild(d); return d; };

    row('HP <input id="m-hp" type="number" min="0" max="20" value="20" style="width:3em"> ' +
        'Hunger <input id="m-hunger" type="number" min="0" max="20" value="20" style="width:3em"> ' +
        'Sat <input id="m-sat" type="number" min="0" max="20" step="0.5" value="5" style="width:3em"> ' +
        '<button id="m-set">set</button>');
    p.querySelector('#m-set').onclick = () => {
      engine.state.hp = Number(p.querySelector('#m-hp').value);
      engine.state.hunger = Number(p.querySelector('#m-hunger').value);
      engine.state.saturation = Number(p.querySelector('#m-sat').value);
    };

    const optsHtml = data.items.map(i => `<option value="${i.id}">${i.display_name}</option>`).join('');
    row(`<select id="m-food">${optsHtml}</select> <button id="m-redeem">redeem</button>`);
    p.querySelector('#m-redeem').onclick = () => {
      engine.addRedemption({
        foodId: p.querySelector('#m-food').value,
        cost: (data.rewards.find(r => r.food_id === p.querySelector('#m-food').value) || {}).cost || 100,
        user: 'mockViewer',
      });
    };

    row('timescale <input id="m-ts" type="range" min="0" max="16" step="0.5" value="' + opts.timescale + '"> <span id="m-tsv">' + opts.timescale + '×</span>');
    p.querySelector('#m-ts').oninput = (e) => { opts.timescale = Number(e.target.value); p.querySelector('#m-tsv').textContent = e.target.value + '×'; };

    row('<button id="m-kill">kill player</button> <button id="m-clear">clear saved state</button>');
    p.querySelector('#m-kill').onclick = () => engine.damage(999, 'mock', 0);
    p.querySelector('#m-clear').onclick = () => { try { localStorage.removeItem(LS_KEY); } catch (e) {} };

    row('<button id="m-export">export</button> <button id="m-import">import</button><br><textarea id="m-state" rows="4"></textarea>');
    p.querySelector('#m-export').onclick = () => { p.querySelector('#m-state').value = engine.serialize(); };
    p.querySelector('#m-import').onclick = () => { engine.restore(p.querySelector('#m-state').value); };

    const st = document.createElement('div');
    st.className = 'mock-row'; st.id = 'm-status'; st.style.whiteSpace = 'pre';
    p.appendChild(st);
    setInterval(() => {
      const s = engine.state;
      st.textContent = `net:${MCNet.mode} hp:${s.hp} hunger:${s.hunger} sat:${s.saturation.toFixed(1)} ex:${s.exhaustion.toFixed(2)}\n` +
        `xp:${s.xp.total.toFixed(0)} L${s.xp.level} q:${s.queue.length} fx:[${s.effects.map(e => e.id + ' ' + Math.ceil((e.until - s.t) / 1000) + 's').join(', ')}]` +
        (s.death ? `\nDEAD ${(Math.max(0, s.death.until - s.t) / 1000).toFixed(1)}s` : '');
    }, 250);

    document.body.appendChild(p);
  }

  console.log('[MC] widget up — profile:', cfg['sim.activity_profile'], 'net:', MCNet.mode);
})();
