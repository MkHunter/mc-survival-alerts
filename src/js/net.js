/* net.js — Streamer.bot WS client wrapper.
 * In : redemptions (Twitch.RewardRedemption). Out: DoAction MC Fulfill / MC Refund.
 * Falls back to offline log mode when the vendored client is absent or ?mock=1.
 */
window.MCNet = (function () {
  'use strict';
  let client = null;
  let mode = 'offline'; // 'live' | 'offline'
  let actionNames = { fulfill: 'MC Fulfill', refund: 'MC Refund' };
  const log = [];

  function note(msg) {
    log.push(msg);
    if (log.length > 50) log.shift();
    console.log('[MCNet]', msg);
  }

  function init(opts, handlers) {
    actionNames.fulfill = opts.cfg['fulfill.action_name'] || 'MC Fulfill';
    actionNames.refund = opts.cfg['refund.action_name'] || 'MC Refund';

    if (opts.mock) { mode = 'offline'; note('mock mode — network offline'); return; }
    if (typeof StreamerbotClient === 'undefined') { mode = 'offline'; note('streamerbot client missing — offline'); return; }

    try {
      client = new StreamerbotClient({
        host: opts.host,
        port: opts.port,
        endpoint: '/',
        password: opts.password || undefined,
        onConnect: () => note('connected to ' + opts.host + ':' + opts.port),
        onDisconnect: () => note('disconnected'),
        onError: (e) => note('error: ' + (e && e.message || e)),
      });
      client.on('Twitch.RewardRedemption', ({ data }) => {
        try { handlers.onRedemption(data || {}); } catch (e) { console.error(e); }
      });
      mode = 'live';
      note('connecting to ' + opts.host + ':' + opts.port + ' …');
    } catch (e) {
      mode = 'offline';
      note('connect failed: ' + e.message);
    }
  }

  function doAction(name, args) {
    if (mode !== 'live' || !client) { note('doAction (offline) ' + name + ' ' + JSON.stringify(args)); return Promise.resolve(); }
    return Promise.resolve(client.doAction({ name }, args)).catch(e => note('doAction ' + name + ' failed: ' + (e && e.message || e)));
  }

  function sendFulfill(entry) {
    return doAction(actionNames.fulfill, {
      redemptionId: entry.redemptionId, rewardId: entry.rewardId, user: entry.user, foodId: entry.foodId,
    });
  }
  function sendRefund(entry, reason) {
    return doAction(actionNames.refund, {
      redemptionId: entry.redemptionId, rewardId: entry.rewardId, user: entry.user, foodId: entry.foodId, reason,
    });
  }

  // mock-mode injection helper
  function injectRedemption(data) { return Promise.resolve(); }

  return {
    init, sendFulfill, sendRefund, doAction, injectRedemption,
    get mode() { return mode; },
    get log() { return log.slice(); },
  };
})();
