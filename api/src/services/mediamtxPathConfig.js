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
 */
function withPlanLimits(plan, conf) {
  return {
    ...(conf || {}),
    maxReaders: maxReadersForPlan(plan),
  };
}

module.exports = { FREE_MAX_READERS, maxReadersForPlan, withPlanLimits };
