/* anim.js — eating animation, particles, flashes, shakes, vignettes.
 * DOM-based (≤30 particles is trivial for CEF). Sprites tinted via canvas sampling.
 */
window.MCAnim = (function () {
  'use strict';
  let S = 3; // gui scale
  let els = {};
  let data = null;
  const colorCache = {}; // foodId -> [r,g,b][] sampled from sprite
  let chewTimer = null;

  function init(opts) {
    S = opts.scale;
    data = opts.data;
    els.core = document.getElementById('hud-core');
    els.eatSprite = document.getElementById('eat-sprite');
    els.particles = document.getElementById('particles');
    els.flash = document.getElementById('damage-flash');
    els.vignetteBlind = document.getElementById('vignette-blindness');
    els.vignetteDark = document.getElementById('vignette-darkness');
  }

  function item(foodId) { return data.items.find(i => i.id === foodId) || null; }
  function spriteSrc(foodId) {
    const it = item(foodId);
    return it && it.asset ? '../assets/food/' + it.asset : null;
  }

  // sample opaque pixel colors from the item sprite (once, cached)
  function colorsFor(foodId, cb) {
    if (colorCache[foodId]) return cb(colorCache[foodId]);
    const src = spriteSrc(foodId);
    if (!src) return cb([[128, 80, 32]]);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        const cols = [];
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) cols.push([d[i], d[i + 1], d[i + 2]]);
        colorCache[foodId] = cols.length ? cols : [[128, 80, 32]];
      } catch (e) { colorCache[foodId] = [[128, 80, 32]]; }
      cb(colorCache[foodId]);
    };
    img.onerror = () => { colorCache[foodId] = [[128, 80, 32]]; cb(colorCache[foodId]); };
    img.src = src;
  }

  function spawnParticles(n, palette, purple) {
    if (!els.particles) return;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      const col = purple ? [160 + Math.random() * 60 | 0, 60, 200 + Math.random() * 55 | 0]
                         : palette[Math.floor(Math.random() * palette.length)];
      const size = (2 + Math.random() * 2) * S;
      p.style.width = p.style.height = size + 'px';
      p.style.background = `rgb(${col[0]},${col[1]},${col[2]})`;
      p.style.left = (91 * S + (Math.random() - 0.5) * 30 * S) + 'px'; // hotbar center
      p.style.bottom = (26 * S + Math.random() * 6 * S) + 'px';
      p.style.setProperty('--dx', ((Math.random() - 0.5) * 14 * S) + 'px');
      p.style.setProperty('--dy', ((10 + Math.random() * 14) * S) + 'px');
      els.particles.appendChild(p);
      setTimeout(() => p.remove(), 900);
    }
  }

  // --- events from engine ---
  function eatStart(payload, cfg) {
    const src = spriteSrc(payload.foodId);
    if (!els.eatSprite) return;
    if (src) els.eatSprite.src = src;
    els.eatSprite.classList.add('eating');
    els.eatSprite.style.animationDuration = (1000 / Number(cfg['eat.chew_anim_hz'] || 4)) + 'ms';
    if (item(payload.foodId) && payload.foodId === 'apple_golden_enhanced') els.eatSprite.classList.add('enchanted');
    else els.eatSprite.classList.remove('enchanted');
  }
  function eatStop() {
    if (els.eatSprite) els.eatSprite.classList.remove('eating');
  }
  function bite(payload, cfg) {
    colorsFor(payload.foodId, (cols) => spawnParticles(Number(cfg['eat.particles_per_bite']) || 3, cols, false));
  }
  function teleport(cfg) {
    spawnParticles(Number(cfg['chorus.particle_burst']) || 30, null, true);
    shake(Number(cfg['chorus.hud_shake_ms']) || 500);
  }
  function damageFlash(cfg) {
    if (els.flash) {
      els.flash.classList.remove('active');
      void els.flash.offsetWidth; // restart transition
      els.flash.classList.add('active');
      els.flash.style.transitionDuration = (Number(cfg['ui.damage_flash_ms']) || 500) + 'ms';
    }
    shake(150);
  }
  function shake(ms) {
    if (!els.core) return;
    els.core.classList.remove('shake');
    void els.core.offsetWidth;
    els.core.classList.add('shake');
    clearTimeout(chewTimer);
    chewTimer = setTimeout(() => els.core && els.core.classList.remove('shake'), ms);
  }
  function setSway(on) { els.core && els.core.classList.toggle('sway', !!on); }
  function setBlindness(on) { els.vignetteBlind && els.vignetteBlind.classList.toggle('on', !!on); }
  function setDarkness(on) { els.vignetteDark && els.vignetteDark.classList.toggle('on', !!on); }

  return { init, eatStart, eatStop, bite, teleport, damageFlash, shake, setSway, setBlindness, setDarkness };
})();
