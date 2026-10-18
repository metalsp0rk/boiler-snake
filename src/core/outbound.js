/**
 * The ONE supervisor → client/outbound resolution (audit #462, H1-3).
 *
 * Six tickers each carried their own resolveOutbound copy — already drifted
 * into six distinct bodies — plus three copies of resolveDiscordClient,
 * all keeping a "pre-PR 7 raw discord.js client" duck-typed leg that no
 * caller has had since the PR 7 cutover: boot builds exactly ONE
 * supervisor shape (src/platform/boot.js: { discord getter, fluxer Map,
 * clientForCommunity }) and every ticker's start()/tick() receives it.
 * Dead legs kept six times gave false confidence that raw clients were a
 * supported call shape (the duck-typed-truth root-cause pattern).
 *
 * Contract now:
 *  - `null`/undefined supervisor → null (fluxer-less / not-yet-booted
 *    paths stay tolerable, exactly as every copy did);
 *  - a supervisor (anything with clientForCommunity) → routed through it;
 *    resolveDiscordClient answers supervisor.discord (null on
 *    Discord-less deployments — callers already tolerate that);
 *  - a NON-supervisor object → throws, naming the stale call site,
 *    because the raw-client pass-through it relied on is gone: silence is
 *    what let the six copies rot in the first place.
 *
 * @param {object|null} supervisor
 * @param {{label?: string}} [opts] log/throw label (the feature's prefix)
 * @returns {object|null}
 */
function resolveDiscordClient(supervisor, { label = "outbound" } = {}) {
  if (!supervisor) return null;
  if (typeof supervisor.clientForCommunity === "function") {
    return supervisor.discord ?? null;
  }
  throw new Error(
    `[${label}] resolveDiscordClient: expected the PR 7 supervisor ` +
      "({ discord, fluxer, clientForCommunity }); got a raw/foreign object — " +
      "the pre-PR 7 raw-client leg was deleted in #462, pass the boot supervisor",
  );
}

/**
 * Resolve the OutboundClient serving one community.
 *
 * @param {object|null} supervisor
 * @param {number} communityId
 * @param {{label?: string}} [opts] log/throw label (the feature's prefix)
 * @returns {object|null}
 */
function resolveOutbound(supervisor, communityId, { label = "outbound" } = {}) {
  if (!supervisor) return null;
  if (typeof supervisor.clientForCommunity === "function") {
    try {
      return supervisor.clientForCommunity(communityId) ?? null;
    } catch (err) {
      console.error(
        `[${label}] clientForCommunity(${communityId}) threw: ${err?.message || err}`,
      );
      return null;
    }
  }
  throw new Error(
    `[${label}] resolveOutbound: expected the PR 7 supervisor ` +
      "({ discord, fluxer, clientForCommunity }); got a raw/foreign object — " +
      "the pre-PR 7 raw-client leg was deleted in #462, pass the boot supervisor",
  );
}

module.exports = { resolveDiscordClient, resolveOutbound };
