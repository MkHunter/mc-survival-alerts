/* config.js — URL params merged over GAME_DATA.config (simulation_config sheet). */
window.MCConfig = (function () {
  'use strict';
  function parse(gameConfig) {
    const q = new URLSearchParams(location.search);
    const cfg = Object.assign({}, gameConfig);
    const num = (k, d) => (q.has(k) && q.get(k) !== '' && !isNaN(Number(q.get(k)))) ? Number(q.get(k)) : d;

    if (q.get('profile')) cfg['sim.activity_profile'] = q.get('profile');

    const opts = {
      host: q.get('host') || cfg['ws.default_host'] || '127.0.0.1',
      port: num('port', Number(cfg['ws.default_port']) || 8080),
      password: q.get('pw') || '',
      scale: num('scale', Number(cfg['ui.gui_scale']) || 3),
      volume: num('volume', Number(cfg['sound.volume'] != null ? cfg['sound.volume'] : 0.8)),
      timescale: Math.max(0.1, num('timescale', 1)),
      mock: q.get('mock') === '1',
      fresh: q.get('fresh') === '1',
    };
    return { cfg, opts };
  }
  return { parse };
})();
