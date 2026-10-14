/**
 * `/event wizard` — step-by-step event creation over DMs (#224, E15).
 *
 * One state machine in `event_wizards` (one row per community+user): each
 * step asks exactly one question in the DM, answers arrive as DM text or
 * wizard buttons (`ev:w:*`). Answers accumulate in the `draft` JSON; the
 * finish step creates the event and posts it immediately (the user already
 * confirmed the preview).
 *
 * A user can hold wizards in several communities — an inbound DM resolves
 * through listUserOpenWizards; with more than one open, the user picks.
 */
const db = require("../../db");
const repo = require("../../db/repositories/events");
const { replyEphemeral } = require("../../core/interaction");
const { ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags } = require("discord.js");
const { parseDuration } = require("./timeParse");
const { parseSignupOptionSpec } = require("./ui");
const service = require("./service");
const ui = require("./ui");

const STEPS = ["start", "channel", "duration", "options", "confirm"];
const CANCEL_WORDS = new Set(["cancel", "nevermind", "never mind", "stop"]);

const WIZ_BTN = "ev:w:";

function btnId(action, extra = "") {
  return extra ? `${WIZ_BTN}${action}:${extra}` : `${WIZ_BTN}${action}`;
}

function parseDraft(row) {
  try {
    return JSON.parse(row.draft || "{}");
  } catch {
    return {};
  }
}

function saveState(communityId, userId, step, draft, eventId = null) {
  repo.upsertEventWizard(communityId, userId, {
    step,
    draft: JSON.stringify(draft),
    eventId,
  });
}

/** Button row shared by wizard prompts. */
function controlRow({ cancel = true, extra = [] }) {
  const row = new ActionRowBuilder();
  for (const b of extra) row.addComponents(b);
  if (cancel) {
    row.addComponents(
      new ButtonBuilder().setCustomId(btnId("cancel")).setLabel("Cancel").setStyle(ButtonStyle.Danger)
    );
  }
  return [row];
}

/** Resolve the DM target (cache → fetch). */
async function dmUser(client, userId) {
  if (!client?.users) return null;
  const cached = client.users.cache?.get?.(userId) ?? null;
  if (cached) return cached;
  try {
    return await client.users.fetch(userId);
  } catch {
    return null;
  }
}

/** Ask the current step's question in the user's DM. */
async function ask(client, row) {
  const draft = parseDraft(row);
  const titlePart = draft.title ? `**${draft.title}** — ` : "";
  let content;
  let components = [];
  if (row.step === "start") {
    content =
      `${titlePart}When should it start?\n` +
      "Send a time like `in 2h`, `tomorrow 7pm`, `Fri 19:00`, or `2026-11-05 19:00`.";
  } else if (row.step === "channel") {
    content =
      "Which channel should the event be posted in?\n" +
      "Use the button for the channel you were in, or send a #channel mention.";
    components = controlRow({
      extra: draft.default_channel_id
        ? [
            new ButtonBuilder()
              .setCustomId(btnId("chan", draft.default_channel_id))
              .setLabel("Post here")
              .setStyle(ButtonStyle.Primary),
          ]
        : [],
    });
  } else if (row.step === "duration") {
    content = "How long does it run? Send `90`, `1h30m`… or tap a preset.";
    components = controlRow({
      extra: ["30m", "1h", "2h"].map((v) =>
        new ButtonBuilder().setCustomId(btnId("dur", v)).setLabel(v).setStyle(ButtonStyle.Secondary)
      ),
    });
  } else if (row.step === "options") {
    content =
      "Signup options: keep the default **Yes / No / Maybe**, or send your own like\n" +
      "`Main stage, Side stage, Workshop` (optionally `Label|20` for a 20-slot cap).";
    components = controlRow({
      extra: [
        new ButtonBuilder()
          .setCustomId(btnId("opts", "default"))
          .setLabel("Yes / No / Maybe")
          .setStyle(ButtonStyle.Primary),
      ],
    });
  } else if (row.step === "confirm") {
    return sendConfirmPrompt(client, row);
  } else {
    return false;
  }
  const user = await dmUser(client, row.user_id);
  if (!user) return false;
  const dm = await user.send({ content, components });
  return Boolean(dm);
}

/** Build + DM the confirmation preview (event already exists as draft row). */
async function sendConfirmPrompt(client, row) {
  const event = repo.getEventById(row.event_id);
  if (!event) return false;
  const options = repo.listEventOptions(event.id);
  const user = await dmUser(client, row.user_id);
  if (!user) return false;
  const dm = await user.send({
    ...ui.buildPreviewEmbed(event, { options }),
    components: controlRow({
      extra: [
        new ButtonBuilder()
          .setCustomId(btnId("post"))
          .setLabel("✅ Post it")
          .setStyle(ButtonStyle.Success),
      ],
    }),
  });
  return Boolean(dm);
}

/** `/event wizard` entry point (creates/resumes state, opens the DM). */
async function start(client, interaction, communityId) {
  const userId = interaction.user.id;
  const openElsewhere = repo
    .listUserOpenWizards(userId)
    .filter((w) => w.community_id !== communityId);
  const existing = repo.getEventWizard(communityId, userId);
  const draft = existing ? parseDraft(existing) : {};
  draft.default_channel_id = interaction.channelId || draft.default_channel_id || null;
  draft.creator_id = userId;

  const resume = existing && existing.step !== "title";
  if (!resume) saveState(communityId, userId, "title", draft, null);
  const virtual = beginTitle(communityId, userId, draft);
  const ok = resume ? await ask(client, existing) : await askTitle(client, virtual);
  if (!ok) {
    if (existing) await cleanupDraft(existing);
    repo.deleteEventWizard(communityId, userId);
    await replyEphemeral(
      interaction,
      "I couldn't message you — allow DMs from server members, then run `/event wizard` again. You can also use `/event create` directly.",
    );
    return;
  }
  let note = "";
  if (!resume) {
    // title step is in-memory until the first answer lands
  } else {
    note = " (resuming where you left off)";
  }
  if (openElsewhere.length) {
    note += ` — you also have a wizard open in ${openElsewhere.length} other server(s); DM answers go to the most recent one.`;
  }
  await replyEphemeral(
    interaction,
    `Check your DMs${note} — I'll walk you through it, one question at a time.`,
  );
}

/** Step 0 lives in-memory (no row until a title exists). */
function beginTitle(communityId, userId, draft) {
  return { community_id: communityId, user_id: userId, step: "title", draft, event_id: null };
}

async function askTitle(client, row) {
  const user = await dmUser(client, row.user_id);
  if (!user) return false;
  const dm = await user.send({
    content:
      "Let's build an event 🎪 — **what's it called?**\nSend just the title (or `cancel` to stop).",
    components: controlRow({ cancel: true }),
  });
  return Boolean(dm);
}

async function promptCommunityPick(interaction, openRows) {
  const lines = [];
  for (const w of openRows) {
    const c = require("../../platform/community").getCommunityById(w.community_id);
    lines.push(`- server \`${c?.externalGuildId ?? w.community_id}\` — /event wizard there to continue`);
  }
  await replyEphemeral(
    interaction,
    `You have a wizard open in more than one server:\n${lines.join("\n")}\nContinue it there (DM me the answer and I'll route it if only one is active).`,
  );
}

/** Inbound DM text → current step's answer. Returns true when consumed. */
async function handleDmMessage(client, message) {
  const author = message.author;
  if (!author || author.bot) return false;
  const open = repo.listUserOpenWizards(author.id);
  if (!open.length) return false;
  if (open.length > 1) {
    await message.reply(
      "You have event wizards open in several servers — answer in the one you're working on, or `cancel all` to clear them."
    ).catch(() => {});
    if (CANCEL_WORDS.has(String(message.content || "").toLowerCase())) {
      for (const w of open) repo.deleteEventWizard(w.community_id, author.id);
      await message.reply("Cleared all wizards.").catch(() => {});
      return true;
    }
    return true; // consumed: don't treat as a command
  }
  const row = open[0];
  const text = String(message.content || "").trim();
  if (CANCEL_WORDS.has(text.toLowerCase())) {
    await cleanupDraft(row);
    repo.deleteEventWizard(row.community_id, author.id);
    await message.reply("Wizard cancelled 🗑️").catch(() => {});
    return true;
  }
  try {
    const next = await answer(row, text, client);
    if (typeof next === "string") {
      // Invalid answer — keep the step, ask again.
      await message.reply(next).catch(() => {});
      return true;
    }
    await message.reply("👍").catch(() => {});
    if (next.done) {
      repo.deleteEventWizard(row.community_id, author.id);
      return true;
    }
    await ask(client, next.row);
  } catch (err) {
    console.error(`[events] wizard answer failed user=${author.id}:`, err?.message || err);
    await message.reply(
      `Something broke while saving that: \`${err?.message || err}\` — your answers are kept; send it again or \`cancel\`.`
    ).catch(() => {});
  }
  return true;
}

async function cleanupDraft(row) {
  if (row.event_id) {
    try {
      const ev = repo.getEventById(row.event_id);
      if (ev && ev.status !== "posted") await service.deleteEvent(null, ev, { removeDiscord: false });
    } catch (err) {
      console.error(`[events] wizard draft cleanup event=${row.event_id}:`, err?.message || err);
    }
  }
}

/** Validate + store one answer; returns {row, done} or a retry message. */
async function answer(row, text, client) {
  const draft = parseDraft(row);
  const communityId = row.community_id;
  const settings = repo.getEventGuildSettings(communityId);

  if (row.step === "title") {
    if (!text || text.length > 150) return "Keep the title under 150 characters.";
    draft.title = text;
    saveState(communityId, row.user_id, "start", draft);
    return { row: { ...row, step: "start", draft } };
  }

  if (row.step === "start") {
    const parsed = service.resolveStartAt(text, settings);
    if (!parsed.ok) return `I couldn't read that time (${parsed.error}). Try \`in 2h\` or \`tomorrow 7pm\`.`;
    draft.start_at = parsed.atMs;
    const chRes = createDraftRow(row, draft);
    if (!chRes.ok) return chRes.error;
    draft.event_id = chRes.event.id;
    saveState(communityId, row.user_id, "channel", draft, chRes.event.id);
    return { row: { ...row, step: "channel", draft, event_id: chRes.event.id } };
  }

  if (row.step === "channel") {
    const id = extractChannelId(text) || draft.default_channel_id || null;
    if (!id) return "Send a #channel mention (or the **Post here** button).";
    repo.updateEvent(draft.event_id, { channel_id: id });
    saveState(communityId, row.user_id, "duration", { ...draft, channel_id: id }, draft.event_id);
    return { row: { ...row, step: "duration", draft: { ...draft, channel_id: id } } };
  }

  if (row.step === "duration") {
    const minutes = text.match(/^\d+$/) ? Number(text) : parseDuration(text)?.minutes ?? null;
    if (!minutes || minutes < 1) return "Give me a duration like `90` or `1h30m` (or tap a preset).";
    const endAt = draft.start_at + minutes * 60_000;
    repo.updateEvent(draft.event_id, { duration_minutes: minutes, end_at: endAt });
    const d2 = { ...draft, duration_minutes: minutes };
    saveState(communityId, row.user_id, "options", d2, draft.event_id);
    return { row: { ...row, step: "options", draft: d2 } };
  }

  if (row.step === "options") {
    let specs = null;
    if (text.toLowerCase() === "default" || text.toLowerCase() === "yes no maybe") {
      specs = require("./presets").defaultSpecs();
    } else {
      const res = parseSignupOptionSpec(text);
      if (!res.ok) return res.error;
      specs = res.options;
    }
    const optRes = require("./options").replaceOptions(draft.event_id, specs);
    if (!optRes.ok) return optRes.error;
    saveState(communityId, row.user_id, "confirm", draft, draft.event_id);
    return { row: { ...row, step: "confirm", draft, event_id: draft.event_id } };
  }

  return "You're all set here — tap **Post it** in the DM.";
}

/** First persistent draft row (title+start known). */
function createDraftRow(row, draft) {
  const existing = draft.event_id ? repo.getEventById(draft.event_id) : null;
  if (existing) {
    repo.updateEvent(existing.id, {
      title: draft.title,
      start_at: draft.start_at,
      cutoff_at: draft.start_at,
    });
    return { ok: true, event: repo.getEventById(existing.id) };
  }
  return repo.createEvent({
    communityId: row.community_id,
    creatorId: row.user_id,
    title: draft.title,
    status: "pending_confirm",
    startAt: draft.start_at,
    channelId: draft.default_channel_id || null,
    cutoff_at: draft.start_at,
  });
}

function extractChannelId(text) {
  const m = /(?:<#)?(\d{17,20})>?/.exec(String(text || ""));
  return m ? m[1] : null;
}

/** Wizard button dispatch (customId `ev:w:<action>[:<value>]`). */
async function handleButton(interaction, ctx) {
  const parts = interaction.customId.slice(WIZ_BTN.length).split(":");
  const action = parts[0];
  const value = parts[1];
  const client = ctx?.supervisor?.discord ?? ctx?.supervisor ?? null;
  if (action === "cancel") {
    const existing = findWizardForButton(interaction);
    if (existing) {
      await cleanupDraft(existing);
      repo.deleteEventWizard(existing.community_id, existing.user_id);
    }
    await interaction.update({ content: "Wizard cancelled 🗑️", embeds: [], components: [] });
    return;
  }
  const row = findWizardForButton(interaction);
  if (!row) {
    await interaction.update({ content: "That wizard is no longer active — run `/event wizard` again.", embeds: [], components: [] });
    return;
  }
  const draft = parseDraft(row);

  if (action === "chan") {
    repo.updateEvent(row.event_id ?? draft.event_id, { channel_id: value });
    const d2 = { ...draft, channel_id: value };
    const next = { ...row, step: "duration", draft: d2 };
    saveState(row.community_id, row.user_id, "duration", d2, row.event_id ?? draft.event_id);
    await interaction.update({ content: `Posting in <#${value}>. ✅`, components: [] });
    await ask(client, next);
    return;
  }
  if (action === "dur") {
    const minutes = { "30m": 30, "1h": 60, "2h": 120 }[value] ?? 60;
    const evId = row.event_id ?? draft.event_id;
    if (evId && draft.start_at) {
      repo.updateEvent(evId, { duration_minutes: minutes, end_at: draft.start_at + minutes * 60_000 });
    }
    const d2 = { ...draft, duration_minutes: minutes };
    saveState(row.community_id, row.user_id, "options", d2, evId);
    await interaction.update({ content: `Running ${value}. ✅`, components: [] });
    await ask(client, { ...row, step: "options", draft: d2 });
    return;
  }
  if (action === "opts") {
    const specs = require("./presets").defaultSpecs();
    const evId = row.event_id ?? draft.event_id;
    const res = require("./options").replaceOptions(evId, specs);
    if (!res.ok) {
      await interaction.reply({ content: res.error, flags: MessageFlags.Ephemeral });
      return;
    }
    saveState(row.community_id, row.user_id, "confirm", draft, evId);
    await interaction.update({ content: "Yes / No / Maybe it is. ✅", components: [] });
    await sendConfirmPrompt(client, { ...row, step: "confirm", event_id: evId });
    return;
  }
  if (action === "post") {
    const evId = row.event_id ?? draft.event_id;
    const event = repo.getEventById(evId);
    if (!event) {
      await interaction.update({ content: "That draft vanished — run `/event wizard` again.", embeds: [], components: [] });
      return;
    }
    const res = await service.postEventNow(client, event, { actorId: row.user_id });
    if (!res.ok) {
      await interaction.reply({
        content: `Couldn't post it: \`${res.error}\` — the draft stays in /event list for \`/event post\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    repo.deleteEventWizard(row.community_id, row.user_id);
    await interaction.update({
      content: `Posted ✅ — <@${row.user_id}> your event is live${res.warnings?.length ? ` (with notes: ${res.warnings.join("; ")})` : ""}.`,
      embeds: [],
      components: [],
      allowedMentions: { parse: ["users"] },
    });
    return;
  }
  await interaction.reply({ content: "Unknown wizard step.", flags: MessageFlags.Ephemeral });
}

/**
 * Wizard buttons live in DMs (no guild): the customId carries no context,
 * so resolve the single open wizard for the clicking user.
 */
function findWizardForButton(interaction) {
  const open = repo.listUserOpenWizards(interaction.user.id);
  return open[0] || null;
}

module.exports = {
  STEPS,
  WIZ_BTN,
  start,
  ask,
  askTitle,
  handleDmMessage,
  handleButton,
  saveState,
  parseDraft,
};
