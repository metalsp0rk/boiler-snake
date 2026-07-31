const { PermissionFlagsBits, MessageFlags } = require("discord.js");
const { EventEmitter } = require("events");
const { IDS, ADMIN_PERMS } = require("./fixtures");

/**
 * Map-like role cache with .has / .keys / iteration used by the bot.
 */
function createRoleCache(initialIds = []) {
  const map = new Map();
  for (const id of initialIds) {
    map.set(id, { id });
  }
  return map;
}

/**
 * @param {object} [opts]
 */
function createUser(opts = {}) {
  const id = opts.id || IDS.member;
  const username = opts.username || `user_${id}`;
  const bot = !!opts.bot;
  const sends = [];
  const user = {
    id,
    username,
    tag: `${username}#0000`,
    bot,
    sends,
    send: async (content) => {
      sends.push(content);
      return { id: `dm-${id}`, content };
    },
  };
  return user;
}

/**
 * @param {object} opts
 * @param {object} opts.guild
 * @param {object} opts.user
 * @param {string[]} [opts.roleIds]
 * @param {boolean} [opts.admin]
 * @param {bigint|number} [opts.permissions] raw bitfield; admin implies ManageGuild
 */
function createMember(opts) {
  const { guild, user } = opts;
  const roleIds = opts.roleIds ? [...opts.roleIds] : [];
  // @everyone is guild id in Discord
  if (!roleIds.includes(guild.id)) roleIds.unshift(guild.id);

  const rolesCache = createRoleCache(roleIds);
  const added = [];
  const removed = [];

  let permissionsBits =
    opts.permissions != null
      ? BigInt(opts.permissions)
      : opts.admin
        ? ADMIN_PERMS
        : 0n;

  const member = {
    id: user.id,
    user,
    guild,
    displayName: opts.displayName || user.username,
    roles: {
      cache: rolesCache,
      add: async (roleId) => {
        rolesCache.set(roleId, { id: roleId });
        added.push(roleId);
        return member;
      },
      remove: async (roleId) => {
        rolesCache.delete(roleId);
        removed.push(roleId);
        return member;
      },
    },
    permissions: {
      has: (flag) => (permissionsBits & BigInt(flag)) === BigInt(flag),
    },
    _addedRoles: added,
    _removedRoles: removed,
    setAdmin(isAdmin) {
      permissionsBits = isAdmin ? ADMIN_PERMS : 0n;
    },
  };
  return member;
}

/**
 * @param {object} [opts]
 */
function createTextChannel(opts = {}) {
  const id = opts.id || IDS.channelGeneral;
  const guild = opts.guild || null;
  const messages = new Map();
  const sent = [];

  const channel = {
    id,
    name: opts.name || `channel-${id}`,
    guild,
    guildId: guild?.id,
    type: 0,
    messages: {
      cache: messages,
      fetch: async (messageId) => {
        if (messages.has(messageId)) return messages.get(messageId);
        return null;
      },
    },
    sent,
    isTextBased: () => true,
    send: async (payload) => {
      const msgId = `msg-sent-${sent.length + 1}`;
      const msg = {
        id: msgId,
        content: typeof payload === "string" ? payload : payload?.content,
        embeds: typeof payload === "object" ? payload?.embeds : undefined,
        files: typeof payload === "object" ? payload?.files : undefined,
        channel,
        guild,
        url: `https://discord.com/channels/${guild?.id || "0"}/${id}/${msgId}`,
        author: opts.clientUser || { id: "bot", bot: true },
        pin: async () => {},
        react: async () => {},
        reactions: { cache: new Map(), removeAll: async () => {} },
      };
      sent.push(payload);
      messages.set(msg.id, msg);
      return msg;
    },
  };
  return channel;
}

/**
 * @param {object} [opts]
 */
function createGuild(opts = {}) {
  const id = opts.id || IDS.guild;
  const membersById = new Map();
  const channelsById = new Map();
  const rolesById = new Map();
  const scheduledEventsById = new Map();
  const bans = [];
  const voiceStates = new Map();
  let roleSeq = 1;

  const guild = {
    id,
    name: opts.name || `Guild ${id}`,
    afkChannelId: opts.afkChannelId || null,
    members: {
      cache: membersById,
      fetch: async (arg) => {
        if (typeof arg === "string") {
          if (membersById.has(arg)) return membersById.get(arg);
          throw new Error(`Member ${arg} not found`);
        }
        if (arg && Array.isArray(arg.user)) {
          const col = new Map();
          for (const uid of arg.user) {
            if (membersById.has(uid)) col.set(uid, membersById.get(uid));
          }
          return col;
        }
        return membersById;
      },
      ban: async (userId, banOpts) => {
        bans.push({ userId, ...banOpts });
        return { userId };
      },
    },
    channels: {
      cache: channelsById,
      fetch: async (channelId) => {
        if (channelsById.has(channelId)) return channelsById.get(channelId);
        return null;
      },
    },
    roles: {
      cache: rolesById,
      create: async (data) => {
        const roleId = data.id || `role-${roleSeq++}`;
        const role = {
          id: roleId,
          name: data.name || roleId,
          mentionable: !!data.mentionable,
          hoist: !!data.hoist,
          guild,
          members: new Map(),
          setName: async (name) => {
            role.name = name;
            return role;
          },
          delete: async () => {
            rolesById.delete(roleId);
          },
        };
        rolesById.set(roleId, role);
        return role;
      },
      fetch: async (roleId) => rolesById.get(roleId) || null,
    },
    scheduledEvents: {
      cache: scheduledEventsById,
      fetch: async (arg) => {
        if (typeof arg === "string") {
          return scheduledEventsById.get(arg) || null;
        }
        return scheduledEventsById;
      },
    },
    voiceStates: {
      cache: voiceStates,
    },
    _bans: bans,
    addMember(member) {
      membersById.set(member.id, member);
      return member;
    },
    addChannel(channel) {
      channel.guild = guild;
      channel.guildId = guild.id;
      channelsById.set(channel.id, channel);
      return channel;
    },
    addScheduledEvent(event) {
      event.guild = guild;
      event.guildId = guild.id;
      scheduledEventsById.set(event.id, event);
      return event;
    },
    setVoiceState(userId, state) {
      voiceStates.set(userId, state);
    },
  };
  return guild;
}

/**
 * @param {object} opts
 * @param {object} opts.guild
 * @param {string} [opts.id]
 * @param {string} [opts.name]
 * @param {number} [opts.scheduledStartTimestamp]
 * @param {number} [opts.status] GuildScheduledEventStatus
 * @param {string} [opts.creatorId]
 * @param {string[]} [opts.subscriberIds]
 */
function createScheduledEvent(opts) {
  const guild = opts.guild;
  const id = opts.id || `evt-${Date.now()}`;
  const subscriberIds = opts.subscriberIds ? [...opts.subscriberIds] : [];
  const subscribers = new Map();
  for (const uid of subscriberIds) {
    subscribers.set(uid, { user: { id: uid } });
  }

  const event = {
    id,
    name: opts.name || "Test Event",
    guild,
    guildId: guild?.id,
    creatorId: opts.creatorId || null,
    status: opts.status != null ? opts.status : 1, // Scheduled
    scheduledStartTimestamp:
      opts.scheduledStartTimestamp != null
        ? opts.scheduledStartTimestamp
        : Date.now() + 3 * 24 * 60 * 60 * 1000,
    fetchSubscribers: async () => subscribers,
    setSubscribers(ids) {
      subscribers.clear();
      for (const uid of ids) subscribers.set(uid, { user: { id: uid } });
    },
  };
  return event;
}

/**
 * @param {object} [opts]
 */
function createClient(opts = {}) {
  const emitter = new EventEmitter();
  const guilds = new Map();
  const channels = new Map();

  const client = {
    user: opts.user || { id: IDS.bot, username: "BoilerSnake", bot: true, tag: "BoilerSnake#0000" },
    guilds: {
      cache: guilds,
      fetch: async (guildId) => {
        if (guilds.has(guildId)) return guilds.get(guildId);
        return null;
      },
    },
    channels: {
      cache: channels,
      fetch: async (channelId) => {
        if (channels.has(channelId)) return channels.get(channelId);
        for (const g of guilds.values()) {
          const ch = await g.channels.fetch(channelId);
          if (ch) return ch;
        }
        return null;
      },
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    off: emitter.off.bind(emitter),
    addGuild(guild) {
      guilds.set(guild.id, guild);
      return guild;
    },
  };
  return client;
}

/**
 * @param {object} opts
 */
function createMessage(opts) {
  const guild = opts.guild;
  const channel = opts.channel;
  const author = opts.author;
  const member = opts.member || null;
  let deleted = false;

  const message = {
    id: opts.id || `msg-${Date.now()}`,
    content: opts.content || "hello",
    guild,
    guildId: guild?.id,
    channel,
    channelId: channel?.id,
    author,
    member,
    deletable: opts.deletable !== false,
    deleted: false,
    delete: async () => {
      deleted = true;
      message.deleted = true;
    },
    _wasDeleted: () => deleted,
  };
  return message;
}

/**
 * @param {object} opts
 */
function createReaction(opts) {
  const message = opts.message;
  const emoji = opts.emoji || { id: null, name: "👍" };
  const reaction = {
    partial: !!opts.partial,
    message,
    emoji,
    users: { cache: new Map() },
    remove: async () => {},
    fetch: async () => reaction,
  };
  return reaction;
}

/**
 * Build a ChatInputCommandInteraction-like object.
 *
 * @param {object} opts
 * @param {string} opts.commandName
 * @param {object} opts.guild
 * @param {object} opts.user
 * @param {object} [opts.member]
 * @param {string} [opts.channelId]
 * @param {boolean} [opts.admin]
 * @param {object} [opts.options] map of option name → value
 * @param {string} [opts.subcommand]
 * @param {string|null} [opts.subcommandGroup]
 * @param {boolean} [opts.autocomplete]
 * @param {string} [opts.focused] autocomplete focused option name
 */
function createChatInputInteraction(opts) {
  const guild = opts.guild ?? null;
  const user = opts.user;
  const member = opts.member;
  const channelId = opts.channelId || IDS.channelGeneral;
  const optionsMap = opts.options || {};
  const subcommand = opts.subcommand ?? null;
  const subcommandGroup = opts.subcommandGroup ?? null;
  const isAutocomplete = !!opts.autocomplete;

  const replies = [];
  const followUps = [];
  const responds = [];

  let admin =
    opts.admin != null
      ? opts.admin
      : member
        ? member.permissions.has(PermissionFlagsBits.ManageGuild)
        : false;

  const memberPermissions = {
    has: (flag) => {
      if (admin && flag === PermissionFlagsBits.ManageGuild) return true;
      if (member?.permissions) return member.permissions.has(flag);
      return false;
    },
  };

  const modals = [];

  const interaction = {
    commandName: opts.commandName,
    guild,
    guildId: guild?.id ?? null,
    channelId,
    user,
    member: member || null,
    memberPermissions,
    replied: false,
    deferred: false,
    replies,
    followUps,
    responds,
    modals,
    isChatInputCommand: () => !isAutocomplete,
    isAutocomplete: () => isAutocomplete,
    isModalSubmit: () => false,
    options: {
      getSubcommand: (required = true) => {
        if (subcommand == null && required) throw new Error("No subcommand");
        return subcommand;
      },
      getSubcommandGroup: (required = false) => {
        if (subcommandGroup == null && required) throw new Error("No group");
        return subcommandGroup;
      },
      getUser: (name) => {
        const v = optionsMap[name];
        if (v === undefined) return null;
        return v;
      },
      getInteger: (name) => {
        const v = optionsMap[name];
        if (v === undefined) return null;
        return v;
      },
      getNumber: (name) => {
        const v = optionsMap[name];
        if (v === undefined) return null;
        return v;
      },
      getBoolean: (name) => {
        const v = optionsMap[name];
        if (v === undefined) return null;
        return v;
      },
      getString: (name) => {
        const v = optionsMap[name];
        if (v === undefined) return null;
        return v;
      },
      getChannel: (name, required = false) => {
        const v = optionsMap[name];
        if (v == null && required) throw new Error(`Missing channel ${name}`);
        return v ?? null;
      },
      getRole: (name, required = false) => {
        const v = optionsMap[name];
        if (v == null && required) throw new Error(`Missing role ${name}`);
        return v ?? null;
      },
      getFocused: (asObject = false) => {
        const name = opts.focused || "query";
        const value = optionsMap[name] ?? optionsMap.focused ?? "";
        if (asObject) return { name, value };
        return value;
      },
    },
    reply: async (payload) => {
      interaction.replied = true;
      replies.push(payload);
      return payload;
    },
    followUp: async (payload) => {
      followUps.push(payload);
      return payload;
    },
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload) => {
      replies.push({ ...payload, _edited: true });
      return payload;
    },
    showModal: async (modal) => {
      modals.push(modal);
      interaction.replied = true;
      return modal;
    },
    respond: async (choices) => {
      responds.push(choices);
    },
    setAdmin(isAdmin) {
      admin = isAdmin;
    },
  };

  return interaction;
}

/**
 * Build a ModalSubmitInteraction-like object.
 *
 * @param {object} opts
 * @param {string} opts.customId
 * @param {object} opts.guild
 * @param {object} opts.user
 * @param {object} [opts.member]
 * @param {object} [opts.fields] map customId → value(s)
 *   text: string, stringSelect: string[], channelSelect: Map|object
 * @param {boolean} [opts.admin]
 */
function createModalSubmitInteraction(opts) {
  const guild = opts.guild ?? null;
  const user = opts.user;
  const member = opts.member;
  const fieldMap = opts.fields || {};
  const replies = [];
  let admin =
    opts.admin != null
      ? opts.admin
      : member
        ? member.permissions.has(PermissionFlagsBits.ManageGuild)
        : false;

  const memberPermissions = {
    has: (flag) => {
      if (admin && flag === PermissionFlagsBits.ManageGuild) return true;
      if (member?.permissions) return member.permissions.has(flag);
      return false;
    },
  };

  const fields = {
    getTextInputValue: (id) => {
      const v = fieldMap[id];
      if (v == null) throw new Error(`Missing text field ${id}`);
      return typeof v === "string" ? v : String(v.value ?? "");
    },
    getStringSelectValues: (id) => {
      const v = fieldMap[id];
      if (v == null) throw new Error(`Missing select ${id}`);
      if (Array.isArray(v)) return v;
      return v.values || [];
    },
    getSelectedChannels: (id, required = false) => {
      const v = fieldMap[id];
      if (v == null) {
        if (required) throw new Error(`Missing channels ${id}`);
        return null;
      }
      if (v instanceof Map) return v;
      if (v && v.channels) return v.channels;
      if (v && v.id) {
        const m = new Map([[v.id, v]]);
        m.first = () => v;
        return m;
      }
      return null;
    },
  };

  const interaction = {
    customId: opts.customId,
    guild,
    guildId: guild?.id ?? null,
    user,
    member: member || null,
    memberPermissions,
    fields,
    client: opts.client || null,
    replied: false,
    deferred: false,
    replies,
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isModalSubmit: () => true,
    reply: async (payload) => {
      interaction.replied = true;
      replies.push(payload);
      return payload;
    },
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload) => {
      replies.push({ ...payload, _edited: true });
      return payload;
    },
    setAdmin(isAdmin) {
      admin = isAdmin;
    },
  };
  return interaction;
}

/**
 * @param {object} interaction
 * @returns {string}
 */
function lastReplyContent(interaction) {
  const r = interaction.replies[interaction.replies.length - 1];
  if (!r) return "";
  return typeof r === "string" ? r : r.content || "";
}

/**
 * @param {object} interaction
 * @returns {boolean}
 */
function lastReplyEphemeral(interaction) {
  const r = interaction.replies[interaction.replies.length - 1];
  if (!r || typeof r === "string") return false;
  return r.flags === MessageFlags.Ephemeral || r.ephemeral === true;
}

module.exports = {
  createRoleCache,
  createUser,
  createMember,
  createTextChannel,
  createGuild,
  createScheduledEvent,
  createClient,
  createMessage,
  createReaction,
  createChatInputInteraction,
  createModalSubmitInteraction,
  lastReplyContent,
  lastReplyEphemeral,
  MessageFlags,
  PermissionFlagsBits,
};
