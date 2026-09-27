/* audio.js — sound pools, volume, random pick + rate jitter. file:// safe (<audio>). */
window.MCAudio = (function () {
  'use strict';
  const BASE = '../assets/sounds/';
  // manifests match assets/sounds/<pool>/ extracted in §10
  const POOLS = {
    eat: ['eat/eat1.ogg', 'eat/eat2.ogg', 'eat/eat3.ogg'],
    drink: ['drink/drink1.ogg', 'drink/drink2.ogg', 'drink/drink3.ogg', 'drink/drink4.ogg'],
    burp: ['burp/burp.ogg'],
    teleport: ['teleport/teleport1.ogg', 'teleport/teleport2.ogg'],
    levelup: ['levelup/levelup.ogg'],
    hurt: ['hurt/hurt1.ogg', 'hurt/hurt2.ogg', 'hurt/hurt3.ogg', 'hurt/hurt4.ogg'],
    death: ['death/death1.ogg', 'death/death2.ogg'],
  };
  let volume = 0.8;
  const cache = {}; // path -> HTMLAudioElement (template)

  function init(opts) {
    volume = opts.volume != null ? opts.volume : 0.8;
    for (const pool of Object.values(POOLS)) {
      for (const rel of pool) {
        const a = new Audio(BASE + rel);
        a.preload = 'auto';
        cache[rel] = a;
      }
    }
  }

  function play(poolName, opts2) {
    const pool = POOLS[poolName];
    if (!pool || !pool.length) return;
    const rel = pool[Math.floor(Math.random() * pool.length)];
    const tpl = cache[rel];
    if (!tpl) return;
    const a = tpl.cloneNode(); // cheap clone, shares decoded buffer in CEF
    a.volume = volume;
    a.playbackRate = (opts2 && opts2.rate) || (0.9 + Math.random() * 0.2);
    const p = a.play();
    if (p && p.catch) p.catch(() => {}); // pre-gesture autoplay guard (CEF ignores anyway)
  }

  return { init, play, setVolume(v) { volume = v; } };
})();
