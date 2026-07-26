const assert = require("node:assert/strict");
const { lastReplyContent, lastReplyEphemeral } = require("./discord");

function assertHasReply(interaction) {
  assert.ok(
    interaction.replies.length > 0,
    "expected at least one interaction.reply"
  );
}

function assertEphemeralReply(interaction, pattern) {
  assertHasReply(interaction);
  assert.equal(lastReplyEphemeral(interaction), true, "expected ephemeral reply");
  const content = lastReplyContent(interaction);
  if (pattern instanceof RegExp) {
    assert.match(content, pattern);
  } else if (typeof pattern === "string") {
    assert.ok(
      content.includes(pattern),
      `expected reply to include ${JSON.stringify(pattern)}, got ${JSON.stringify(content)}`
    );
  }
}

function assertReplyContains(interaction, textOrPattern) {
  assertHasReply(interaction);
  const content = lastReplyContent(interaction);
  if (textOrPattern instanceof RegExp) {
    assert.match(content, textOrPattern);
  } else {
    assert.ok(
      content.includes(textOrPattern),
      `expected reply to include ${JSON.stringify(textOrPattern)}, got ${JSON.stringify(content)}`
    );
  }
}

function assertNoReply(interaction) {
  assert.equal(interaction.replies.length, 0, "expected no replies");
}

function assertXp(db, guildId, userId, expected) {
  assert.equal(db.getXp(guildId, userId), expected);
}

function assertBanned(guild, userId) {
  assert.ok(
    guild._bans.some((b) => b.userId === userId),
    `expected ban for ${userId}, bans=${JSON.stringify(guild._bans)}`
  );
}

function assertNotBanned(guild, userId) {
  assert.ok(
    !guild._bans.some((b) => b.userId === userId),
    `expected no ban for ${userId}`
  );
}

function assertRoleGranted(member, roleId) {
  assert.ok(
    member.roles.cache.has(roleId) || member._addedRoles.includes(roleId),
    `expected role ${roleId} granted`
  );
}

function assertRoleRemoved(member, roleId) {
  assert.ok(
    !member.roles.cache.has(roleId) || member._removedRoles.includes(roleId),
    `expected role ${roleId} removed`
  );
}

module.exports = {
  assertHasReply,
  assertEphemeralReply,
  assertReplyContains,
  assertNoReply,
  assertXp,
  assertBanned,
  assertNotBanned,
  assertRoleGranted,
  assertRoleRemoved,
};
