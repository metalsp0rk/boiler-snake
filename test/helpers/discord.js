const { PermissionFlagsBits, MessageFlags } = require("discord.js");
const { EventEmitter } = require("events");
const { IDS, ADMIN_PERMS } = require("./fixtures");

/**
 * Map-like role cache with .has / .keys / iteration used by the bot.
 */
/**
 * Real code reads role caches through discord.js Collection helpers
 * (`cache.some(...)`, `cache.find(...)`). Plain Maps lack those — attach the
 * same read-side API so production code runs unmodified against the mock.
 * Mutators stay pure Map semantics.
 */
function asCollectionLike(map) {
  if (!map.some) {
    map.some = (fn) => {
      for (const [k, v] of map) if (fn(v, k, map)) return true;
      return false;
    };
  }
  if (!map.find) {
    map.find = (fn) => {
      for (const [k, v] of map) if (fn(v, k, map)) return v;
      return undefined;
    };
  }
  if (!map.filter) {
    map.filter = (fn) => {
      const out = new Map();
      for (const [k, v] of map) if (fn(v, k, map)) out.set(k, v);
      return out;
    };
  }
  if (!map.first) {
    map.first = (n = 1) => {
      const it = map.values();
      const out = [];
      for (let i = 0; i < n; i++) {
        const r = it.next();
        if (r.done) break;
        out.push(r.value);
      }
      return n === 1 ? out[0] : out;
    };
  }
  return map;
}

function createRoleCache(initialIds = []) {
  const map = new Map();
  for (const id of initialIds) {
    map.set(id, { id });
  }
  return asCollectionLike(map);
}

/**
 * Give a user-like object the DM surface:
 * - `sends[]` raw payloads (assertion buffer) with `sent` as an ALIAS of the
 *   same array — either name may be read or cleared;
 * - `send(payload)` records the raw payload and returns a fake Message with
 *   edit/delete (thread-less, like real DMs);
 * - `dmsClosed = true` → send throws the discord.js CANNOT_SEND_TO_USER
 *   shape (`{ message: "Cannot send messages to this user", code: 50007 }`).
 * Users that already expose `send()` are returned untouched, so per-test DM
 * spies keep winning. Applied to members too (member.user stays the SAME
 * object as interaction.user / the users-cache object — identity contract).
 *
 * @param {object} user
 * @returns {object} the same object, DM-attached
 */
function attachDmSurface(user) {
  if (!user || typeof user !== "object" || typeof user.send === "function") {
    return user;
  }
  const sends = user.sends || [];
  user.sends = sends;
  user.sent = user.sent || sends;
  if (user.dmsClosed == null) user.dmsClosed = false;
  user.send = async (payload) => {
    if (user.dmsClosed) {
      throw Object.assign(new Error("Cannot send messages to this user"), {
        code: 50007,
      });
    }
    sends.push(payload);
    // Minimal DM channel so message.channel.send(...) round-trips to sends.
    const dmChannel =
      user.dmChannel ||
      (user.dmChannel = { id: `dm-channel-${user.id}`, type: 1, send: (p) => user.send(p) });
    return createFakeMessage({
      id: `dm-${user.id}`,
      payload,
      channel: dmChannel,
      guild: null,
      threads: false,
    });
  };
  return user;
}

/**
 * Shared fake Message for channel/thread/DM sends and seeded messages.
 * Beyond the recorded payload it supports the lifecycle surface product
 * code uses on fetched/sent messages:
 * - `edit(patch)` merges content/embeds/components/files/allowedMentions
 *   into the message and appends the RAW patch to `edits[]` (assertion
 *   buffer); returns the message (discord.js resolves to the Message);
 * - `startThread({ name, invitable, reason })` (no args tolerated) creates
 *   a thread-like channel on the parent, records it in `threadsStarted[]`
 *   and sets `threadId`; honors parent `__failThreads` (50013);
 * - `pin()/unpin()` toggle `pinned`, `pin()` returns the message;
 * - `delete()` sets `deleted` and runs `onDelete` (channel cache removal).
 *
 * @param {object} params
 * @param {string} params.id
 * @param {object|string} params.payload
 * @param {object} params.channel
 * @param {object|null} params.guild
 * @param {object} [params.author]
 * @param {boolean} [params.threads] allow startThread (false for DMs)
 * @param {(msg: object) => void} [params.onDelete]
 */
function createFakeMessage({ id, payload, channel, guild, author, threads = true, onDelete = null }) {
  const msg = {
    id,
    content: typeof payload === "string" ? payload : payload?.content,
    embeds: typeof payload === "object" ? payload?.embeds : undefined,
    files: typeof payload === "object" ? payload?.files : undefined,
    components:
      typeof payload === "object" ? payload?.components : undefined,
    allowedMentions:
      typeof payload === "object" ? payload?.allowedMentions ?? null : null,
    mentions:
      (typeof payload === "object" && payload?.mentions) || {
        users: new Map(),
        roles: new Map(),
        channels: new Map(),
        repliedMessage: null,
        repliedUser: null,
      },
    channel,
    guild,
    createdTimestamp: Date.now(),
    url: `https://discord.com/channels/${guild?.id || "0"}/${channel?.id || "0"}/${id}`,
    author: author || { id: "bot", bot: true, username: "bot" },
    attachments: new Map(),
    reactions: { cache: new Map(), removeAll: async () => {} },
    react: async () => {},
    pinned: false,
    threadId: null,
    deleted: false,
    /** Raw patches passed to edit(), in order (assertion buffer). */
    edits: [],
    /** Threads created from this message (assertion buffer). */
    threadsStarted: [],
    edit: async (patch) => {
      const p = typeof patch === "string" ? { content: patch } : patch || {};
      msg.edits.push(patch);
      for (const key of [
        "content",
        "embeds",
        "components",
        "files",
        "allowedMentions",
      ]) {
        if (p[key] !== undefined) msg[key] = p[key];
      }
      return msg;
    },
    pin: async () => {
      msg.pinned = true;
      return msg;
    },
    unpin: async () => {
      msg.pinned = false;
      return msg;
    },
    delete: async () => {
      msg.deleted = true;
      if (onDelete) onDelete(msg);
      return msg;
    },
  };
  msg._wasDeleted = () => msg.deleted;
  if (threads) {
    msg.startThread = async (threadOpts) => {
      const thread = createThreadChannel(channel, threadOpts || {});
      msg.threadsStarted.push(thread);
      msg.threadId = thread.id;
      return thread;
    };
  }
  return msg;
}

/**
 * @param {object} [opts]
 */
function createUser(opts = {}) {
  const id = opts.id || IDS.member;
  const username = opts.username || `user_${id}`;
  return attachDmSurface({
    id,
    username,
    tag: `${username}#0000`,
    bot: !!opts.bot,
  });
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
  // Keep member.user identity-stable AND DM-capable (sent[]/send()/
  // dmsClosed) even when a test hands in a plain { id } user object.
  attachDmSurface(user);
  const roleIds = opts.roleIds ? [...opts.roleIds] : [];
  // @everyone is guild id in Discord
  if (!roleIds.includes(guild.id)) roleIds.unshift(guild.id);

  const rolesCache = createRoleCache(roleIds);
  const added = [];
  const removed = [];

  // discord.js `member.roles.highest`: the max-position role in the cache.
  // Plain mock roles count as position 1 (above @everyone); roles present in
  // guild.roles.cache use that position. An explicit assignment (e.g. the
  // harness's bot member) wins outright via the setter.
  let highestOverride = null;
  const rolePositionOf = (role) => {
    if (!role || String(role.id) === String(guild.id)) return 0; // @everyone
    const direct = Number(role.position);
    if (role.position != null && Number.isFinite(direct)) return direct;
    const viaGuild = Number(guild.roles?.cache?.get?.(role.id)?.position);
    if (role.position == null && Number.isFinite(viaGuild)) return viaGuild;
    return 1;
  };
  const computeHighest = () => {
    let top = { id: guild.id, name: "@everyone", position: 0 };
    for (const role of rolesCache.values()) {
      const p = rolePositionOf(role);
      if (p > top.position) {
        top = {
          id: role.id,
          name: role.name || String(role.id),
          position: p,
        };
      }
    }
    return top;
  };

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
      get highest() {
        return highestOverride ?? computeHighest();
      },
      set highest(v) {
        highestOverride = v;
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
  const overwrites = new Map();
  /** Ids of messages removed via message.delete() (assertion buffer). */
  const deletedMessages = [];
  let deleted = false;
  let channelName = opts.name || `channel-${id}`;

  // Drop a message from the channel cache when message.delete() is called.
  const onMessageDeleted = (msg) => {
    messages.delete(msg.id);
    deletedMessages.push(msg.id);
  };

  const channel = {
    id,
    get name() {
      return channelName;
    },
    set name(v) {
      channelName = v;
    },
    guild,
    guildId: guild?.id,
    type: opts.type != null ? opts.type : 0,
    parentId: opts.parentId || null,
    permissionOverwrites: {
      cache: overwrites,
      set: async (list) => {
        overwrites.clear();
        for (const ow of list || []) {
          overwrites.set(ow.id, ow);
        }
        channel._overwrites = [...overwrites.values()];
      },
      edit: async (targetId, perms) => {
        overwrites.set(targetId, { id: targetId, ...perms });
        channel._overwrites = [...overwrites.values()];
      },
    },
    _overwrites: [],
    messages: {
      cache: messages,
      fetch: async (arg) => {
        // fetch(messageId) single
        if (typeof arg === "string") {
          if (messages.has(arg)) return messages.get(arg);
          return null;
        }
        // fetch({ limit, before|after }) collection-like. Selection follows
        // the Discord REST contract: `before` → the limit messages NEAREST
        // the cursor (descending); `after`-only → the limit messages
        // NEAREST the cursor (ascending); bare limit → newest.
        const limit = arg?.limit || 100;
        const ascending = Boolean(arg?.after) && !arg?.before;
        let all = [...messages.values()].sort((a, b) =>
          ascending
            ? String(a.id).localeCompare(String(b.id))
            : String(b.id).localeCompare(String(a.id))
        );
        if (arg?.before) {
          all = all.filter((m) => String(m.id) < String(arg.before));
        }
        if (arg?.after) {
          all = all.filter((m) => String(m.id) > String(arg.after));
        }
        const slice = all.slice(0, limit);
        return new Map(slice.map((m) => [m.id, m]));
      },
    },
    /** Payloads passed to send() (for assertions). */
    sent,
    _deletedMessages: deletedMessages,
    /** Bot user stamped on sent messages (author identity, if provided). */
    _clientUser: opts.clientUser || null,
    deleted: false,
    isTextBased: () => true,
    /**
     * Minimal ThreadManager: channel.threads.create({ name, invitable,
     * reason, private }) → thread-like channel sharing the per-guild
     * `thread-N` id space with message.startThread().
     */
    threads: {
      cache: new Map(),
      create: async (threadOpts) =>
        createThreadChannel(channel, threadOpts || {}),
    },
    permissionsFor: () => ({
      has: () => true,
    }),
    setName: async (name) => {
      channelName = name;
      return channel;
    },
    delete: async () => {
      deleted = true;
      channel.deleted = true;
      if (guild?.channels?.cache) {
        guild.channels.cache.delete(id);
      }
      return channel;
    },
    _wasDeleted: () => deleted,
    send: async (payload) => {
      const msgId = `msg-sent-${sent.length + 1}-${id}`;
      const msg = createFakeMessage({
        id: msgId,
        payload,
        channel,
        guild,
        author: opts.clientUser,
        onDelete: onMessageDeleted,
      });
      sent.push(payload);
      messages.set(msg.id, msg);
      return msg;
    },
    /** Seed a user message into the channel (tests / archive). */
    addMessage(msgOpts = {}) {
      const msgId = msgOpts.id || `msg-seed-${messages.size + 1}-${id}`;
      const msg = createFakeMessage({
        id: msgId,
        payload: msgOpts,
        channel,
        guild,
        author: msgOpts.author || {
          id: IDS.member,
          username: "member",
          tag: "member#0000",
        },
        onDelete: onMessageDeleted,
      });
      // Seed defaults differ from a send() payload; keep them exact.
      msg.content = msgOpts.content || "";
      msg.embeds = msgOpts.embeds || [];
      msg.attachments = msgOpts.attachments || new Map();
      if (msgOpts.createdTimestamp != null) {
        msg.createdTimestamp = msgOpts.createdTimestamp;
      }
      messages.set(msgId, msg);
      return msg;
    },
  };
  return channel;
}

/**
 * Create a thread-like fake channel (discord.js PublicThread=11 /
 * PrivateThread=12). Full channel surface (send/edit/archive/setName/...)
 * plus `parent`, `archived`, `invitable` and a minimal thread `members`
 * manager. Registered in BOTH `parent.threads.cache` and the guild channels
 * cache; ids come from a per-guild `thread-N` counter shared with
 * message.startThread(). Set `parent.__failThreads = true` to make thread
 * creation throw the Discord 50013 "Missing Permissions" shape.
 *
 * @param {object|null} parent channel the thread is started from
 * @param {object} [opts] { name, invitable, reason, private, type, id }
 */
function createThreadChannel(parent, opts = {}) {
  const guild = opts.guild || parent?.guild || null;
  if (parent && parent.__failThreads) {
    throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
  }
  let seq;
  if (guild) {
    guild._threadSeq = (guild._threadSeq || 0) + 1;
    seq = guild._threadSeq;
  } else {
    createThreadChannel._orphanSeq = (createThreadChannel._orphanSeq || 0) + 1;
    seq = createThreadChannel._orphanSeq;
  }
  const privateThread = opts.private === true || opts.type === 12;
  const thread = createTextChannel({
    id: opts.id || `thread-${seq}`,
    guild,
    name: opts.name || `thread-${seq}`,
    type: privateThread ? 12 : 11,
    parentId: parent?.id ?? null,
    // Threads inherit the parent's bot author so thread messages look bot-sent.
    clientUser: opts.clientUser || parent?._clientUser,
  });
  thread.parent = parent || null;
  thread.archived = false;
  thread.locked = false;
  thread.invitable = !!opts.invitable;
  thread._reason = opts.reason ?? null;
  const participants = new Map();
  thread.members = {
    cache: participants,
    add: async (member) => {
      participants.set(String(member?.id ?? member), member);
      return member;
    },
    remove: async (member) => {
      participants.delete(String(member?.id ?? member));
      return member;
    },
  };
  thread.archive = async () => {
    thread.archived = true;
    return thread;
  };
  // discord.js >=14.16 archive toggle (replaces edit({ archived })); the
  // setName inherited from the channel factory already covers renames.
  thread.setArchived = async (archived = true) => {
    thread.archived = !!archived;
    return thread;
  };
  if (parent?.threads?.cache) parent.threads.cache.set(thread.id, thread);
  if (guild?.channels?.cache) guild.channels.cache.set(thread.id, thread);
  return thread;
}

/**
 * @param {object} [opts]
 */
function createGuild(opts = {}) {
  const id = opts.id || IDS.guild;
  const membersById = new Map();
  const channelsById = new Map();
  const rolesById = asCollectionLike(new Map());
  const scheduledEventsById = new Map();
  /** Channels produced by guild.channels.create() (assertion buffer). */
  const createdChannels = [];
  const bans = [];
  const voiceStates = new Map();
  let roleSeq = 1;

  const guild = {
    id,
    name: opts.name || `Guild ${id}`,
    afkChannelId: opts.afkChannelId || null,
    members: {
      cache: membersById,
      me: null,
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
      /** Every channel passed to channels.create() (assertion buffer). */
      created: createdChannels,
      fetch: async (channelId) => {
        if (channelsById.has(channelId)) return channelsById.get(channelId);
        return null;
      },
      create: async (data) => {
        const chId = data.id || `channel-created-${channelsById.size + 1}`;
        const ch = createTextChannel({
          id: chId,
          guild,
          name: data.name || chId,
          type: data.type != null ? data.type : 0,
          parentId: data.parent || data.parentId || null,
        });
        if (data.permissionOverwrites) {
          await ch.permissionOverwrites.set(data.permissionOverwrites);
        }
        // Audit trail: reason + ordered creation log for assertions.
        ch._createReason = data.reason ?? null;
        channelsById.set(chId, ch);
        createdChannels.push(ch);
        return ch;
      },
    },
    roles: {
      cache: rolesById,
      create: async (data) => {
        const seq = roleSeq++;
        const roleId = data.id || `role-${seq}`;
        // Default position stays MANAGEABLE: the tickets/events hierarchy
        // checks require the bot's highest role STRICTLY above created roles,
        // so cap the default below guild.members.me when one is set.
        const botPos = Number(guild.members?.me?.roles?.highest?.position);
        const position =
          data.position != null
            ? data.position
            : Number.isFinite(botPos)
              ? Math.min(seq, Math.max(botPos - 1, 0))
              : seq;
        const role = {
          id: roleId,
          name: data.name || roleId,
          mentionable: !!data.mentionable,
          hoist: !!data.hoist,
          position,
          managed: !!data.managed,
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
 * @param {string} [opts.title] adopt-flow alias of name
 * @param {string} [opts.description]
 * @param {string} [opts.location]
 * @param {string} [opts.channelId]
 * @param {Date} [opts.scheduledStartTime] defaults from the timestamp
 */
function createScheduledEvent(opts) {
  const guild = opts.guild;
  const id = opts.id || `evt-${Date.now()}`;
  const subscriberIds = opts.subscriberIds ? [...opts.subscriberIds] : [];
  const subscribers = new Map();
  for (const uid of subscriberIds) {
    subscribers.set(uid, { user: { id: uid } });
  }
  const startTs =
    opts.scheduledStartTimestamp != null
      ? opts.scheduledStartTimestamp
      : Date.now() + 3 * 24 * 60 * 60 * 1000;

  const event = {
    id,
    name: opts.name || "Test Event",
    // Adopt flow (#225) reads the discord.js scheduled-event fields:
    // title / scheduledStartTime (Date) / description / channelId / location.
    title: opts.title || opts.name || "Test Event",
    description: opts.description || null,
    location: opts.location || null,
    channelId: opts.channelId || null,
    guild,
    guildId: guild?.id,
    creatorId: opts.creatorId || null,
    status: opts.status != null ? opts.status : 1, // Scheduled
    scheduledStartTimestamp: startTs,
    scheduledStartTime: opts.scheduledStartTime || new Date(startTs),
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
  const users = new Map();

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
    // discord.js UsersManager shape (OutboundClient.fetchUser/sendDm use it).
    // Explicit registrations win; otherwise resolve through guild members so
    // harness users (created via createUser, attached with guild.addMember)
    // resolve to the SAME object tests assert sends on.
    users: {
      cache: users,
      addUser(user) {
        users.set(user.id, user);
        return user;
      },
      fetch: async (id) => {
        if (users.has(id)) return users.get(id);
        if (client.user && String(client.user.id) === String(id)) {
          return client.user;
        }
        for (const g of guilds.values()) {
          const m = g.members?.cache?.get?.(id);
          if (m?.user) return m.user;
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
  // DM surface on the interaction user (no-op for harness users) so DM
  // flows can be driven straight from an interaction's user object.
  attachDmSurface(user);
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

  const channel =
    opts.channel ||
    guild?.channels?.cache?.get?.(channelId) ||
    null;

  const interaction = {
    commandName: opts.commandName,
    guild,
    guildId: guild?.id ?? null,
    channelId,
    channel,
    client: opts.client || null,
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
    isButton: () => false,
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
      getMember: (name) => {
        const v = optionsMap[name];
        if (v == null) return null;
        // Option may be a User; resolve guild member when possible
        const id = v.id || v;
        return guild?.members?.cache?.get?.(id) || null;
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
      // discord.js accepts a plain string; normalize it to a payload object
      const obj = typeof payload === "string" ? { content: payload } : { ...payload };
      replies.push({ ...obj, _edited: true });
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
 * @param {string} [opts.channelId] channel for follow-up sends (defaults to
 *   the guild cache entry for the id; pass a channel object to override)
 * @param {object} [opts.channel]
 * @param {object} [opts.message] the message the modal was opened from
 */
function createModalSubmitInteraction(opts) {
  const guild = opts.guild ?? null;
  const user = opts.user;
  attachDmSurface(user); // DM-capable, identity-stable user (see chat input)
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

  // Modal handlers post follow-up results to the interaction channel.
  const channelId = opts.channelId || opts.channel?.id || null;
  const channel =
    opts.channel ||
    guild?.channels?.cache?.get?.(channelId) ||
    null;

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
    channelId,
    channel,
    // Component message the modal was opened from (assertion context).
    message: opts.message || null,
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
    isButton: () => false,
    reply: async (payload) => {
      interaction.replied = true;
      replies.push(payload);
      return payload;
    },
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload) => {
      // discord.js accepts a plain string; normalize it to a payload object
      const obj = typeof payload === "string" ? { content: payload } : { ...payload };
      replies.push({ ...obj, _edited: true });
      return payload;
    },
    setAdmin(isAdmin) {
      admin = isAdmin;
    },
  };
  return interaction;
}

/**
 * Build a ButtonInteraction-like object.
 *
 * @param {object} opts
 * @param {string} opts.customId
 * @param {object} opts.guild
 * @param {object} opts.user
 * @param {object} [opts.member]
 * @param {object} [opts.client]
 * @param {boolean} [opts.admin]
 * @param {string} [opts.channelId] channel for follow-up sends (defaults to
 *   the guild cache entry for the id; pass a channel object to override)
 * @param {object} [opts.channel]
 * @param {object} [opts.message] the message the button lives on
 */
function createButtonInteraction(opts) {
  const guild = opts.guild ?? null;
  const user = opts.user;
  attachDmSurface(user); // DM-capable, identity-stable user (see chat input)
  const member = opts.member;
  const replies = [];
  const updates = [];
  const modals = [];
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

  // Channel/message context: ev: handlers post results to interaction.channel
  // and re-edit interaction.message.
  const channelId = opts.channelId || opts.channel?.id || null;
  const channel =
    opts.channel ||
    guild?.channels?.cache?.get?.(channelId) ||
    null;

  const interaction = {
    customId: opts.customId,
    guild,
    guildId: guild?.id ?? null,
    channelId,
    channel,
    message: opts.message || null,
    user,
    member: member || null,
    memberPermissions,
    client: opts.client || null,
    replied: false,
    deferred: false,
    replies,
    updates,
    modals,
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isModalSubmit: () => false,
    isButton: () => true,
    reply: async (payload) => {
      interaction.replied = true;
      replies.push(payload);
      return payload;
    },
    update: async (payload) => {
      // Mirrors discord.js >= 14.16: update() throws once deferred or replied.
      if (interaction.deferred || interaction.replied) {
        const err = new Error(
          "The reply to this interaction has already been sent or deferred.",
        );
        err.name = "DiscordjsError";
        err.code = "InteractionAlreadyReplied";
        throw err;
      }
      interaction.replied = true;
      updates.push(payload);
      // Also mirror into replies so assert helpers can see embeds
      replies.push({ ...payload, _updated: true });
      return payload;
    },
    editReply: async (payload) => {
      if (!interaction.deferred && !interaction.replied) {
        const err = new Error("Interaction has already been replied to.");
        err.name = "DiscordjsError";
        err.code = "InteractionNotReplied";
        throw err;
      }
      interaction.deferred = false;
      interaction.replied = true;
      const obj = typeof payload === "string" ? { content: payload } : payload;
      updates.push(obj);
      replies.push({ ...obj, _updated: true });
      return obj;
    },
    deferUpdate: async () => {
      if (interaction.deferred || interaction.replied) {
        const err = new Error(
          "The reply to this interaction has already been sent or deferred.",
        );
        err.name = "DiscordjsError";
        err.code = "InteractionAlreadyReplied";
        throw err;
      }
      interaction.deferred = true;
    },
    // Loader-style defer (public/ephemeral follow-up after the work).
    deferReply: async () => {
      if (interaction.deferred || interaction.replied) {
        const err = new Error(
          "The reply to this interaction has already been sent or deferred.",
        );
        err.name = "DiscordjsError";
        err.code = "InteractionAlreadyReplied";
        throw err;
      }
      interaction.deferred = true;
    },
    /** Tolerated alias of deferReply (task shorthand `defer()`). */
    defer: async () => interaction.deferReply(),
    showModal: async (modal) => {
      modals.push(modal);
      interaction.replied = true;
      return modal;
    },
    followUp: async (payload) => {
      replies.push(payload);
      return payload;
    },
    setAdmin(isAdmin) {
      admin = isAdmin;
    },
  };
  return interaction;
}

/**
 * Flatten embed JSON (plain object or EmbedBuilder-like) into searchable text.
 * @param {object} embed
 * @returns {string}
 */
function embedToSearchText(embed) {
  if (!embed) return "";
  // discord.js EmbedBuilder exposes data via .data or toJSON()
  const data =
    typeof embed.toJSON === "function"
      ? embed.toJSON()
      : embed.data || embed;
  const parts = [];
  if (data.title) parts.push(String(data.title));
  if (data.description) parts.push(String(data.description));
  if (data.footer?.text) parts.push(String(data.footer.text));
  if (Array.isArray(data.fields)) {
    for (const f of data.fields) {
      if (f?.name) parts.push(String(f.name));
      if (f?.value) parts.push(String(f.value));
    }
  }
  return parts.join("\n");
}

function lastReplyContent(interaction) {
  const r = interaction.replies[interaction.replies.length - 1];
  if (!r) return "";
  if (typeof r === "string") return r;
  const content = r.content || "";
  const embedText = Array.isArray(r.embeds)
    ? r.embeds.map(embedToSearchText).filter(Boolean).join("\n")
    : "";
  if (content && embedText) return `${content}\n${embedText}`;
  return content || embedText || "";
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
  attachDmSurface,
  createFakeMessage,
  createThreadChannel,
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
  createButtonInteraction,
  lastReplyContent,
  lastReplyEphemeral,
  MessageFlags,
  PermissionFlagsBits,
};
