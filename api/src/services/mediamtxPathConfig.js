'use strict';

/** Concurrent playback clients per path (HLS, WebRTC, SRT read, etc.). MediaMTX: 0 = unlimited. */
const FREE_MAX_READERS = 10;

/**
 * @param {string | null | undefined} plan from license validate (`free` | `paid`)
 * @returns {number} maxReaders for MediaMTX path config
 */
function maxReadersForPlan(plan) {
  return plan === 'paid' ? 0 : FREE_MAX_READERS;
}

/**
 * Merge MediaMTX path config (e.g. pull `source`) with plan-based limits.
 * When `plan` is still unknown (before first license check), treat as free — conservative.
 *
 * @param {string | null | undefined} plan
 * @param {object} conf  base path config
 * @param {{ protocol: string, mode: string, srtPassword?: string|null, rtmpPassword?: string|null }} [auth]
 */
function withPlanLimits(plan, conf, auth) {
  const base = {
    ...(conf || {}),
    maxReaders: maxReadersForPlan(plan),
  };

  if (!auth || auth.mode !== 'push') return base;

  if (auth.protocol === 'srt' && auth.srtPassword) {
    // SRT passphrase encryption — enforced by MediaMTX natively on the SRT layer
    base.srtPublishPassphrase = auth.srtPassword;
  } else if (auth.protocol === 'rtmp' && auth.rtmpPassword) {
    // RTMP publish auth — encoder must supply user:pass in the RTMP URL
    base.publishUser = 'stream';
    base.publishPass = auth.rtmpPassword;
  }

  return base;
}

module.exports = { FREE_MAX_READERS, maxReadersForPlan, withPlanLimits };
