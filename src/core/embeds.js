/**
 * Embed helpers (#470 H1-7) and the embed BUDGET gate (#837 B2-7).
 */

/**
 * Discord's published embed limits. Per-field truncation helpers live in
 * core/theme.js; before #837 the ACROSS-EMBED total (6000) and the
 * field-count cap (25) existed in NO executable code — `grep 6000 src/`
 * found interval arithmetic, and the only 6000-aware file hand-traced its
 * own section math (tickets/reportEvidence.js). The r2 INT-11 class
 * ("generic-error death on big guilds") stayed open by construction: any
 * future multi-embed composer had no gate to call.
 */
const EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 251,
  fieldValue: 1024,
  footer: 200,
  author: 256,
  fields: 25,
  embedsPerMessage: 10,
  totalChars: 6000, // ACROSS every embed in the message
};

/**
 * Normalize a discord.js MessageEmbed (or any toJSON-carrying embed object)
 * into the plain payload object outbound transports want. Plain objects pass
 * through untouched — mirrors (and stay type-safe for) the fluxer side.
 *
 * Byte-identical copies lived in the githubReleases/twitch/youtube tickers
 * and reactionRoles/service.
 *
 * @param {any} embed
 * @returns {any}
 */
function toPlainEmbed(embed) {
  return embed && typeof embed.toJSON === "function" ? embed.toJSON() : embed;
}

/** Text length of a possibly-missing/plain value (never throws). */
function textLen(v) {
  return typeof v === "string" ? v.length : 0;
}

/** Characters one plain embed contributes to Discord's 6000-char total. */
function embedCharLen(embed) {
  if (!embed || typeof embed !== "object") return 0;
  let n = textLen(embed.title) + textLen(embed.description);
  for (const f of Array.isArray(embed.fields) ? embed.fields : []) {
    n += textLen(f?.name) + textLen(f?.value);
  }
  return n + textLen(embed.footer?.text) + textLen(embed.author?.name);
}

/**
 * Assert a message's embed set against Discord's published caps BEFORE the
 * send. Returns the service shape ({ ok, error }) — rule 6: the gate never
 * throws and never replies; the caller decides how to surface the specific
 * cause (and which degradation path to take).
 *
 * Accepts one plain/serializable embed or an array of them (EmbedBuilders
 * are serialized via toPlainEmbed first).
 *
 * @param {any|any[]} embedsLike
 * @returns {{ ok: true, totalChars: number } | { ok: false, error: string, totalChars: number }}
 */
function assertEmbedBudget(embedsLike) {
  const embeds = (Array.isArray(embedsLike) ? embedsLike : [embedsLike])
    .map((e) => toPlainEmbed(e))
    .filter((e) => e && typeof e === "object");

  const violations = [];
  if (embeds.length > EMBED_LIMITS.embedsPerMessage) {
    violations.push(
      `${embeds.length} embeds exceeds Discord's ${EMBED_LIMITS.embedsPerMessage}-embed cap`,
    );
  }
  let total = 0;
  embeds.forEach((embed, i) => {
    const at = `embed ${i + 1}`;
    const over = (label, len, cap) => {
      if (len > cap) violations.push(`${at}: ${label} is ${len} chars (cap ${cap})`);
    };
    over("title", textLen(embed.title), EMBED_LIMITS.title);
    over("description", textLen(embed.description), EMBED_LIMITS.description);
    over("footer", textLen(embed.footer?.text), EMBED_LIMITS.footer);
    over("author", textLen(embed.author?.name), EMBED_LIMITS.author);
    const fields = Array.isArray(embed.fields) ? embed.fields : [];
    if (fields.length > EMBED_LIMITS.fields) {
      violations.push(`${at}: ${fields.length} fields (cap ${EMBED_LIMITS.fields})`);
    }
    fields.forEach((f, fi) => {
      const len = (v) => textLen(v);
      if (len(f?.name) > EMBED_LIMITS.fieldName) {
        violations.push(`${at} field ${fi + 1}: name is ${len(f?.name)} chars (cap ${EMBED_LIMITS.fieldName})`);
      }
      if (len(f?.value) > EMBED_LIMITS.fieldValue) {
        violations.push(`${at} field ${fi + 1}: value is ${len(f?.value)} chars (cap ${EMBED_LIMITS.fieldValue})`);
      }
    });
    total += embedCharLen(embed);
  });
  if (total > EMBED_LIMITS.totalChars) {
    violations.push(
      `combined embed text is ${total} chars (Discord caps a message's embeds at ${EMBED_LIMITS.totalChars} TOTAL)`,
    );
  }
  return violations.length
    ? { ok: false, error: violations.join("; "), totalChars: total }
    : { ok: true, totalChars: total };
}

module.exports = {
  toPlainEmbed,
  assertEmbedBudget,
  embedCharLen,
  EMBED_LIMITS,
};
