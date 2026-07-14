# Reaction Roles

Bot-owned **panel messages** where members claim roles by reacting with configured emojis. Each option can require a minimum XP level and optionally remove the role when the reaction is removed.

## How It Works

1. An admin creates a **panel** with `/reactionrole panel create` — the bot posts an embed.
2. Options are added with `/reactionrole option add` (emoji → role, min level, removable flag).
3. The bot **updates the embed** and seeds the panel with the configured reactions.
4. When a member reacts:
   - **Configured emoji** + level met → role granted
   - **Configured emoji** + level too low → reaction removed; bot tries to DM the requirement
   - **Unconfigured emoji** → reaction removed immediately
5. When a member removes a reaction on a **removable** option → role removed

Reaction XP is **not** awarded for reactions on managed panels.

Panel embeds show roles as `@Role` for readability, but the bot always sends/edits with **`allowedMentions` disabled** so members are **not** pinged when options are added or the panel is refreshed.

## Why not ephemeral “level too low” replies?

Discord only allows ephemeral messages as replies to **interactions** (slash commands, buttons, selects). Reactions are gateway events, so the bot cannot send an ephemeral notice. Under-level users get a **DM** when possible; otherwise the reaction is simply removed.

## Commands

All subcommands require **Manage Server** (`ManageGuild`).

### Panels

```bash
/reactionrole panel create channel:#roles title:Self Roles description:Pick what fits you
/reactionrole panel edit message_id:123456789 title:Updated Title
/reactionrole panel list
/reactionrole panel delete message_id:123456789
```

`panel create` replies with the panel **message ID** (needed for options) and a jump link.

### Options

```bash
# Start add flow (then send the emoji as your next chat message)
/reactionrole option add message_id:123 role:@Gamer level:5 removable:true

# Permanent veteran badge
/reactionrole option add message_id:123 role:@Veteran level:20 removable:false

/reactionrole option list message_id:123

# Start remove flow (then send the emoji to remove)
/reactionrole option remove message_id:123
```

**Parameters for `option add`**:

| Option | Required | Description |
|--------|----------|-------------|
| `message_id` | Yes | Panel message snowflake |
| `role` | Yes | Role to grant |
| `level` | No | Minimum level (default `0`) |
| `removable` | No | If true (default), removing the reaction removes the role |

Max **20 options** per panel (Discord reaction limit).

### Emoji input (after `option add` / `option remove`)

Discord slash commands have **no emoji picker**, so the bot uses a short **await** flow:

1. Run `/reactionrole option add` (role + options) or `/reactionrole option remove` (panel only).
2. The bot replies (ephemeral): send the emoji as your **next message**.
3. Send a message that is **only** the emoji (unicode, server custom emoji, or a shortcode like `+1` / `:fire:`).
4. On success: panel is updated, bot confirms in-channel, and your emoji message is **deleted**.
5. On invalid input (or emoji not on the panel for remove): bot replies with an error and **keeps waiting**.
6. Type **`stop`** to cancel. Sessions expire after **5 minutes** of inactivity.

| What to send | Example |
|--------------|---------|
| Unicode emoji | `👍` `🎮` |
| Shortcodes | `+1` `:+1:` `:thumbsup:` `:fire:` |
| Custom server emoji | Pick from this server’s emoji picker in chat |

Only one await session per admin per guild at a time (a new add/remove replaces the previous wait).

### Sync / repair

```bash
/reactionrole sync message_id:123456789
```

Rewrites the embed and re-applies bot reactions after manual edits or missing reactions.

## Embed Content

The bot owns the panel message. Title and description come from admin config; the role list is rebuilt whenever options change:

```
Title: Self Roles
Description: Pick what fits you

🎮 → @Gamer — Level 5+
🛡️ → @Veteran — Level 20+ · permanent

Footer: React to claim · remove reaction to drop (where allowed)
```

## Permissions

| Permission | Why |
|------------|-----|
| **Manage Roles** | Grant/remove claimed roles (bot’s top role must be **above** those roles) |
| **Add Reactions** | Seed panel emojis |
| **Read Message History** | Resolve reaction events on older messages |
| **Manage Messages** | Remove other users’ unconfigured / under-level reactions |
| **Use External Emoji** | Not required for guild emoji; useful if you later expand sources |

## Interaction with `/leveltorole`

Reaction roles and level→role mappings are **independent**:

- `/leveltorole` auto-grants/revokes based on level (with grace periods)
- Reaction roles grant on react (and revoke on remove if `removable`)
- **After daily XP decay**, reaction roles are re-checked: if level is below the role’s configured min, the role is removed immediately (see [Daily XP Decay](decay.md))

Avoid mapping the **same role** in both systems unless you intentionally want level sync to override self-serve picks.

## Limitations

- Level re-check for reaction roles runs on **XP decay** for users who lost XP (not on every message or continuous polling)
- No exclusive groups (pick-one-of-N)
- Under-level feedback is DM-only (not ephemeral)
- Custom emoji must belong to **this** server

## Troubleshooting

**Reactions not granting roles**

- Bot role hierarchy: bot’s highest role must sit above the target role
- Bot needs **Manage Roles**
- User must meet the option’s `level`
- Confirm the message is still a registered panel (`/reactionrole panel list`)

**Unconfigured reactions not removed**

- Grant **Manage Messages** so the bot can remove others’ reactions

**Embed out of date**

- Run `/reactionrole sync message_id:...`
