/* ui.js — vanilla Minecraft HUD DOM render. Layers, clips, effect icons, death overlay. */
window.MCUI = (function () {
  'use strict';
  const A = '../assets/'; // asset base (relative to src/index.html)
  let S = 3;
  let data = null;
  let cfg = null;
  let root, core;
  const el = {}; // cached elements
  let absHeartURL = null; // runtime-tinted yellow heart strip
  const slotImgs = [];
  const slotOverlays = [];
  let effectRows = { top: null, bottom: null };
  const iconCache = {}; // effectId -> {img, timer, wrap}
  let lastDeathText = '';

  const g = (n) => (n * S) + 'px'; // gui px -> screen px

  function mk(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    (parent || core || root).appendChild(e);
    return e;
  }
  function img(src, cls, parent) {
    const e = mk('img', cls, parent);
    e.src = src; e.draggable = false;
    return e;
  }

  // tint heart strip red->yellow for absorption hearts
  function tintHearts(cb) {
    if (absHeartURL) return cb(absHeartURL);
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] > 0 && px[i] > px[i + 1]) { // reddish -> yellow
          const r = px[i]; px[i] = r; px[i + 1] = Math.min(255, r * 0.9); px[i + 2] = Math.min(80, px[i + 2]);
        }
      }
      ctx.putImageData(d, 0, 0);
      absHeartURL = c.toDataURL();
      cb(absHeartURL);
    };
    im.onerror = () => cb(A + 'hp_bar_heart.png'); // fallback: untinted
    im.src = A + 'hp_bar_heart.png';
  }

  function init(opts) {
    S = opts.scale; data = opts.data; cfg = opts.cfg;
    root = document.getElementById('hud');
    root.style.setProperty('--s', S);

    // full-screen overlays
    el.vignetteBlind = mk('div', 'vignette', root); el.vignetteBlind.id = 'vignette-blindness';
    el.vignetteDark = mk('div', 'vignette pulsing', root); el.vignetteDark.id = 'vignette-darkness';
    el.death = mk('div', 'death-overlay hidden', root);
    el.deathText = mk('div', 'death-text', el.death);

    // core column
    core = mk('div', '', root); core.id = 'hud-core';
    core.style.width = g(182);

    // hotbar
    el.hotbar = img(A + 'inventory_bar.png', 'layer', core);
    el.hotbar.style.width = g(182); el.hotbar.style.height = g(22); el.hotbar.style.bottom = '0'; el.hotbar.style.left = '0';

    // slots (9): 16px items at 20px pitch, first at x=3, y=3
    for (let i = 0; i < 9; i++) {
      const s = img('', 'layer slot', core);
      s.style.width = g(16); s.style.height = g(16);
      s.style.left = g(3 + i * 20); s.style.bottom = g(3);
      s.style.display = 'none';
      const ov = mk('div', 'layer slot-shimmer', core);
      ov.style.width = g(16); ov.style.height = g(16);
      ov.style.left = g(3 + i * 20); ov.style.bottom = g(3);
      ov.style.display = 'none';
      slotImgs.push(s); slotOverlays.push(ov);
    }

    // selector (24x24, 1px overhang)
    el.selector = img(A + 'inventory_selection_bar.png', 'layer', core);
    el.selector.style.width = g(24); el.selector.style.height = g(24);
    el.selector.style.display = 'none';

    // xp bar
    const xpWrap = mk('div', 'layer', core);
    xpWrap.style.width = g(182); xpWrap.style.height = g(5); xpWrap.style.left = '0'; xpWrap.style.bottom = g(24);
    img(A + 'xp_bar.png', 'layer-fill', xpWrap).style.width = g(182);
    const xpb = xpWrap.firstChild; xpb.style.height = g(5);
    el.xpFillWrap = mk('div', 'clip', xpWrap);
    el.xpFill = img(A + 'xp_bar_full.png', 'layer-fill', el.xpFillWrap);
    el.xpFill.style.width = g(182); el.xpFill.style.height = g(5);
    el.xpLevel = mk('div', 'xp-level', core);
    el.xpLevel.style.bottom = g(30);

    // hearts (left)
    el.hearts = buildBar(core, 34, 'left', {
      base: A + 'hp_bar.png', fill: A + 'hp_bar_heart.png',
    });
    el.flash = img(A + 'hp_bar_white.png', 'layer-fill flash', el.hearts);
    el.flash.id = 'damage-flash';

    // absorption row above hearts
    el.abs = buildBar(core, 44, 'left', { base: null, fill: A + 'hp_bar_heart.png' });
    el.abs.style.display = 'none';

    // hunger (right)
    el.hunger = mk('div', 'layer', core);
    el.hunger.style.width = g(81); el.hunger.style.height = g(9);
    el.hunger.style.right = '0'; el.hunger.style.bottom = g(34);
    const hb = img(A + 'hunger_bar.png', 'layer-fill', el.hunger); hb.style.width = g(81); hb.style.height = g(9);
    el.hungerHalfWrap = mk('div', 'clip', el.hunger);
    el.hungerHalf = img(A + 'hunger_bar_meat_half.png', 'layer-fill', el.hungerHalfWrap);
    el.hungerFullWrap = mk('div', 'clip', el.hunger);
    el.hungerFull = img(A + 'hunger_bar_meat.png', 'layer-fill', el.hungerFullWrap);
    [el.hungerHalf, el.hungerFull].forEach(i => { i.style.width = g(81); i.style.height = g(9); });

    // eat sprite + particles
    el.eatSprite = img('', 'layer', core); el.eatSprite.id = 'eat-sprite';
    el.eatSprite.style.width = g(64); el.eatSprite.style.height = g(64);
    el.eatSprite.style.left = g(91 - 32); el.eatSprite.style.bottom = g(46); // above hearts row
    el.particles = mk('div', '', core); el.particles.id = 'particles';

    // effects column (top-right of source)
    el.effects = mk('div', '', root); el.effects.id = 'effects';
    effectRows.top = mk('div', 'fx-row', el.effects);
    effectRows.bottom = mk('div', 'fx-row', el.effects);

    tintHearts(() => {});
  }

  function buildBar(parent, bottomGui, side, spec) {
    const w = mk('div', 'layer', parent);
    w.style.width = g(81); w.style.height = g(9);
    w.style[side] = '0'; w.style.bottom = g(bottomGui);
    if (spec.base) { const b = img(spec.base, 'layer-fill', w); b.style.width = g(81); b.style.height = g(9); }
    w._fillWrap = mk('div', 'clip', w);
    w._fill = img(spec.fill, 'layer-fill', w._fillWrap);
    w._fill.style.width = g(81); w._fill.style.height = g(9);
    return w;
  }

  function setClipWidth(wrapEl, guiPx) {
    wrapEl.style.width = Math.max(0, Math.min(81, guiPx)) * S + 'px';
  }

  // vanilla strip: icons at 8px pitch, 9px wide. n icons -> n*8+1 px
  function stripWidth(n) { return n <= 0 ? 0 : Math.min(81, (n - 1) * 8 + 9); }

  function fmtTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function placeholderIcon(label) {
    return 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#444"/><text x="8" y="12" font-size="10" text-anchor="middle" fill="#fff" font-family="monospace">${label[0] || '?'}</text></svg>`);
  }

  function render(state, now, engine) {
    if (!root) return;
    const t = state.t;

    // ---- queue slots ----
    const eatIdx = engine.nextEatIndex();
    for (let i = 0; i < 9; i++) {
      const imgEl = slotImgs[i], ovEl = slotOverlays[i];
      const entry = state.queue[i];
      if (!entry) { imgEl.style.display = 'none'; ovEl.style.display = 'none'; continue; }
      const it = data.items.find(x => x.id === entry.foodId);
      const src = it && it.asset ? A + 'food/' + it.asset : null;
      if (imgEl._src !== src) {
        imgEl._src = src;
        if (src) { imgEl.src = src; imgEl.onerror = () => { imgEl.src = placeholderIcon(it ? it.display_name : '?'); imgEl.onerror = null; }; }
      }
      imgEl.style.display = 'block';
      const blocked = !engine.isEligible(entry.foodId);
      imgEl.classList.toggle('waiting', blocked); // blocked item shows "waiting" shake
      // enchanted shimmer
      const ench = entry.foodId === 'apple_golden_enhanced';
      ovEl.style.display = ench ? 'block' : 'none';
    }
    if (state.queue.length && eatIdx >= 0) {
      el.selector.style.display = 'block';
      el.selector.style.left = g(eatIdx * 20 - 1);
      el.selector.style.bottom = g(-1);
      el.selector.classList.toggle('chewing', !!state.eating);
    } else {
      el.selector.style.display = 'none';
    }

    // ---- xp ----
    el.xpFillWrap.style.width = (state.xp.progress * 182 * S) + 'px';
    if (state.xp.level > 0) {
      el.xpLevel.style.display = 'block';
      el.xpLevel.textContent = state.xp.level;
    } else el.xpLevel.style.display = 'none';

    // ---- hearts ----
    const poisoned = state.effects.some(e => e.id === 'poison');
    const withered = state.effects.some(e => e.id === 'wither');
    const wantFill = poisoned ? A + 'hp_bar_heart_poison.png' : A + 'hp_bar_heart.png';
    if (el.hearts._fill._src !== wantFill) { el.hearts._fill._src = wantFill; el.hearts._fill.src = wantFill; }
    el.hearts._fill.classList.toggle('withered', withered);
    setClipWidth(el.hearts._fillWrap, (state.hp / state.maxHp) * 81);
    el.hearts.classList.toggle('lowhp', state.hp > 0 && state.hp <= Number(cfg['ui.low_hp_jitter_hp'] || 4));

    // ---- absorption ----
    if (state.absorption.points > 0) {
      el.abs.style.display = 'block';
      if (absHeartURL && el.abs._fill._src !== absHeartURL) { el.abs._fill._src = absHeartURL; el.abs._fill.src = absHeartURL; }
      setClipWidth(el.abs._fillWrap, (Math.min(20, state.absorption.points) / 20) * 81);
    } else el.abs.style.display = 'none';

    // ---- hunger ----
    const hungerFx = state.effects.some(e => e.id === 'hunger');
    const shake = state.saturation <= 0;
    const suffix = hungerFx ? '_status' : '';
    const shakeSuffix = shake ? '_1' : '';
    const fullSrc = A + `hunger_bar_meat${suffix}${shakeSuffix}.png`;
    const halfSrc = A + `hunger_bar_meat${suffix}_half${shakeSuffix}.png`;
    if (el.hungerFull._src !== fullSrc) { el.hungerFull._src = fullSrc; el.hungerFull.src = fullSrc; }
    if (el.hungerHalf._src !== halfSrc) { el.hungerHalf._src = halfSrc; el.hungerHalf.src = halfSrc; }
    // shake frames are 82px wide
    const wpx = shake ? 82 : 81;
    el.hungerFull.style.width = el.hungerHalf.style.width = g(wpx);
    const fullShanks = Math.floor(state.hunger / 2);
    const halfShown = Math.ceil(state.hunger / 2);
    setClipWidth(el.hungerFullWrap, stripWidth(fullShanks));
    setClipWidth(el.hungerHalfWrap, stripWidth(halfShown));
    el.hunger.classList.toggle('shaking', shake);

    // ---- effects column ----
    renderEffects(state, t);

    // ---- death overlay ----
    if (state.death) {
      el.death.classList.remove('hidden');
      const remain = Math.max(0, (state.death.until - t) / 1000);
      const txt = 'Respawning in ' + remain.toFixed(1) + 's';
      if (txt !== lastDeathText) { lastDeathText = txt; el.deathText.textContent = txt; }
      core.classList.add('dimmed');
    } else {
      el.death.classList.add('hidden');
      core.classList.remove('dimmed');
    }
  }

  function renderEffects(state, t) {
    const blinkMs = Number(cfg['effects.blink_threshold_s'] || 10) * 1000;
    const iconSize = Number(cfg['effects.icon_size_px']) || 18;
    const active = new Set();
    const sorted = state.effects.slice().sort((a, b) => (a.until - b.until)); // soonest first = leftmost
    for (const row of ['top', 'bottom']) {
      const rowEl = effectRows[row];
      const list = sorted.filter(e => {
        const def = data.effects[e.id] || {};
        return (def.hud_row || (def.type === 'positive' ? 'top' : 'bottom')) === row;
      });
      // reconcile
      while (rowEl.children.length > list.length) rowEl.removeChild(rowEl.lastChild);
      list.forEach((e, i) => {
        const def = data.effects[e.id] || {};
        let wrap = rowEl.children[i];
        if (!wrap) {
          wrap = document.createElement('div');
          wrap.className = 'fx-icon';
          const im = document.createElement('img');
          const tm = document.createElement('div');
          tm.className = 'fx-timer';
          wrap.appendChild(im); wrap.appendChild(tm);
          rowEl.appendChild(wrap);
        }
        const im = wrap.children[0], tm = wrap.children[1];
        const key = e.id + ':' + e.level;
        if (wrap._key !== key) {
          wrap._key = key;
          wrap.style.width = wrap.style.height = (iconSize * S) + 'px';
          if (def.icon) {
            im.src = A + 'status_effect/' + def.icon;
            im.onerror = () => { im.src = placeholderIcon(def.display_name || e.id); im.onerror = null; };
          } else {
            im.src = placeholderIcon(def.display_name || e.id);
          }
          im.style.width = im.style.height = (iconSize * S) + 'px';
        }
        const remain = e.until - t;
        tm.textContent = fmtTime(remain) + (e.level > 1 ? ' ' + roman(e.level) : '');
        wrap.classList.toggle('blink', remain < blinkMs);
        active.add(e.id);
      });
    }
  }

  function roman(n) { return ['I', 'II', 'III', 'IV', 'V', 'VI'][n - 1] || String(n); }

  return { init, render };
})();
