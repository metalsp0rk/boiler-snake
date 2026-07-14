# Heisen-XP Bot (discord.js v14)
# MIT LICENSE

Per-guild configurable XP/level bot that tracks:
- **Messages**
- **Reactions**
- **Voice minutes** (per-minute ticker; ignores muted/deafened users and alone-in-channel idling)

Includes:
- Per-guild settings stored in **SQLite** (zero-setup for self-hosting)
- Tunable **decay** (daily cron)
- **Level → Role** automation with **drop-below grace days**
- **Command restriction** to allowed channels per guild
- Admin/mod commands for configuration

## Setup

Requirements: Node.js, Discord.js 14+ (13.x will not work)

1) Install dependencies
```bash
npm install
```

2) Create `.env`
```bash
cp .env.example .env
# edit .env
```

3) Register slash commands
- **Production (multi-guild):** register global commands (default). Note: global command updates can take time to propagate.
- **Development (fast):** set `DEV_GUILD_ID` in `.env` to register instantly to one guild.

```bash
npm run register
```

4) Run bot
```bash
npm start
```

## Required Discord Developer Portal settings

- Enable the **Message Content Intent** if you want `messageCreate` to fire reliably for all message events.
  - Without it, the bot may not receive message content and (depending on gateway/intents configuration) may not receive message events as expected.
- Create Bot & Token from Discord Developer Portal.  Bot must have the following permissions:
![Bot Permissions](https://github.com/zombienerd/HeisenXP-Bot/blob/main/bot_settings.png "Bot Permissions")

## Commands

User commands:
- `/xp [user]`
- `/leaderboard`

Admin/mod commands (requires **Manage Guild** by default):
- `/setxp message:<int> reaction:<int> voice:<int> msgcooldown:<int> reactioncooldown:<int>`
- `/setdecay enabled:<bool> messages:<int> days:<int> percent:<0-95>`
- `/leveltorole set role:<role> level:<int> dropdays:<int>`
- `/leveltorole remove role:<role>`
- `/leveltorole list`
- `/reactionrole panel create|edit|delete|list` — bot-owned self-serve role panels
- `/reactionrole option add|remove|list` — emoji → role (add: send emoji as next message)
- `/reactionrole sync` — repair panel embed + bot reactions
- `/setcommandchannel add channel:<channel>`
- `/setcommandchannel remove channel:<channel>`
- `/setcommandchannel list`
- `/settings` (shows current guild settings, role mappings, allowed channels)

## Database Backup

The bot stores all data in `xpbot.sqlite`. Regular backups are recommended:
```bash
# Manual backup
cp xpbot.sqlite xpbot.sqlite.backup

# Automated daily backup (cron)
0 0 * * * cp /path/to/xpbot.sqlite /backups/xpbot-$(date +\%Y\%m\%d).sqlite
```

To restore from backup:
```bash
# Stop the bot first
cp xpbot.sqlite.backup xpbot.sqlite
# Restart the bot
```

## Notes

- Bot must have **Manage Roles** permission and its highest role must be **above** roles it manages.
- Reaction-role panels also need **Add Reactions**; **Manage Messages** is recommended so the bot can strip unconfigured reactions.
- Voice XP is awarded once per minute for **eligible** users:
  - not muted/deafened (self or server)
  - and in a voice channel with **at least 2 eligible human users**
- SQLite DB file (`xpbot.sqlite`) is created automatically in the project root.
- Ensure you have a font installed that handles symbols and emoji. (sudo apt install fonts-noto-core fonts-noto fonts-dejavu-core fonts-noto-color-emoji)
- Roles for auto-granting must be BELOW the bot's role in the discord server's role settings (Drag bot's role above the desired roles to grant)


Disclaimer: GPT 5.2 was used for debugging and assisting with creation of the leaderboard extents. Bot logo was AI generated.
