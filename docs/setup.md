# Setup and Installation

Step-by-step guide to get Boiler Snake running on your server.

## Prerequisites

- Node.js 18+ (Discord.js v14 requirement), **or** Docker / Docker Compose
- npm or yarn package manager (if not using Docker)
- Discord Bot Token
- Google Cloud Project (optional, for YouTube notifications)

## Step 1: Create a Discord Bot

### 1. Navigate to Developer Portal
Go to [Discord Developer Portal](https://discord.com/developers/applications) and click "New Application".

### 2. Add a Bot
- Click "Add Bot" in the left sidebar
- Under "Privileged Gateway Intents", enable:
  - ✅ **Message Content Intent** (required for reliable message tracking and delete logs)
  - ✅ **Server Members Intent** (recommended; required for kick audit logging)

### 3. Copy Credentials
Copy your credentials to `.env` file (see Step 4):
- Application ID → `CLIENT_ID`
- Bot Token → `DISCORD_TOKEN`

## Step 2: Download and Install

```bash
# Clone the repository
git clone https://github.com/metalsp0rk/boiler-snake.git
cd boiler-snake

# Install dependencies
npm install
```

Or with yarn:
```bash
yarn install
```

## Step 3: Configure Environment

### Create `.env` File

```bash
cp .env.example .env
```

### Edit Required Values

```bash
# Open .env in your editor
nano .env  # or vim, code, etc.
```

**Required Variables**:
```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here
```

**Optional Variables**:
```env
YOUTUBE_API_KEY=your_google_cloud_api_key
DEV_GUILD_ID=server_id_for_fast_registration  # For development

# SQLite location (default: project root). Docker compose sets DATA_DIR=/data
# DATA_DIR=/data
# DB_PATH=/data/xpbot.sqlite
```

### Get DEV_GUILD_ID

To find your server ID:
1. Enable Developer Mode in Discord Settings → Advanced
2. Right-click your server name
3. Click "Copy Server ID"

## Step 4: Set Bot Permissions

Add the bot to your server with required permissions.

### Generate OAuth2 URL

Use Discord's [OAuth2 URL Generator](https://discord.com/developers/applications/{{app_id}}/oauth2/url-generator):

**Scopes**: `bot`
**Bot Permissions**: 
- ✅ Send Messages
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions
- ✅ Use Slash Commands
- ✅ Manage Roles
- ✅ **Manage Channels** *(required for [help tickets](tickets.md))*
- ✅ Read Message History
- ✅ Use External Emoji
- ✅ Ban Members *(required for [honeypot channels](honeypot.md))*

**Ticket system notes:**
- The bot role must sit **above** every role listed in `/staff role list` (otherwise Discord rejects private ticket overwrites with Missing Permissions).
- Prefer a ticket category via `/ticket setcategory` and ensure the bot can create channels there.
- ✅ Manage Messages *(recommended so honeypot messages can be deleted, and so [reaction-role](reaction-roles.md) panels can strip unconfigured reactions)*
- ✅ View Audit Log *(recommended for [audit / message logs](audit-log.md) — attribute bans, kicks, and deletes)*

### Add Bot to Server

Click the generated URL and select your server.

## Step 5: Register Slash Commands

Register the bot's commands with Discord:

```bash
# Production (global, takes time)
npm run register

# Development (fast - use DEV_GUILD_ID from .env)
npm run register
```

**Note**: Global commands can take up to 1 hour to propagate. Using `DEV_GUILD_ID` registers instantly.

### Docker alternative

If you run via Compose instead of bare Node:

```bash
# From repo root, with .env already filled in
docker compose up -d --build
docker compose run --rm bot node src/commands/register.js
```

SQLite is stored on the `bot-data` volume at `/data/xpbot.sqlite`. Published images: `ghcr.io/metalsp0rk/boiler-snake`.

## Step 6: Configure Bot Role Position

⚠️ **Critical**: The bot's role MUST be positioned above roles it manages.

### Steps:
1. Server Settings → Roles
2. Find your bot's role (named after bot)
3. Drag it **ABOVE** the roles you want it to manage
4. Ensure "Manage Roles" permission is enabled

## Step 7: Install Fonts (Ubuntu/Debian)

Only needed for bare-metal installs if you plan to use `/leaderboard` and see emoji properly. **Not required for Docker** (fonts are in the image).

```bash
sudo apt update
sudo apt install fonts-noto-core fonts-dejavu-core fonts-noto-color-emoji
```

**Alternative for Alpine Linux**:
```bash
sudo apk add noto-fonts ttf-dejavu
```

## Step 8: Start the Bot

```bash
npm start
```

Or with Docker Compose:

```bash
docker compose up -d
```

You should see:
```
Boiler Snake logged in as YourBot#1234
```

## First-Time Setup Wizard

### Set XP Rates (Optional)
Adjust defaults to match your server's needs:

```bash
/setxp message:5 reaction:2 voice:1 msgcooldown:20 reactioncooldown:10
```

### Configure Decay (Optional)
Enable XP decay for inactive users:

```bash
/setdecay enabled:true messages:20 days:7 percent:5
```

### Add Role Mappings (Optional)
Create automatic role grants:

```bash
/leveltorole set role:@Member level:5 dropdays:3
/leveltorole set role:@Veteran level:20 dropdays:14
```

### Subscribe to YouTube (Optional)
If you have `YOUTUBE_API_KEY` configured:

```bash
/setyoutube channel #announcements
/youtube add url:https://www.youtube.com/@SomeChannel
/setyoutube interval 5
```

## Database Backup Setup

SQLite database (`xpbot.sqlite`) is created in the project root.

### Manual Backup
```bash
cp xpbot.sqlite xpbot.sqlite.backup
```

### Automated Daily Backup (Linux cron)
Add to crontab:
```bash
# Edit crontab
crontab -e

# Add line for daily 12:00 AM backup
0 0 * * * cp /path/to/boiler-snake/xpbot.sqlite /backup/location/xpbot-$(date +\%Y\%m\%d).sqlite
```

### Restore from Backup
```bash
# Stop the bot first!
cp xpbot.sqlite.backup xpbot.sqlite
npm start
```

## Troubleshooting

### Issue: "Bot doesn't respond to commands"

**Checklist**:
- ✅ Commands registered successfully (`npm run register`)
- ✅ Bot has correct permissions (see Step 4)
- ✅ Message Content Intent enabled in Developer Portal
- ✅ Bot is online (check status in Discord)

### Issue: "Permission denied on admin commands"

Verify user or role has **Manage Guild** permission:
1. Right-click user/role → Edit
2. Check "Administrator" or "Manage Server"
3. Save changes

### Issue: "Leaderboard shows tofu blocks/boxes"

Missing emoji fonts. Install system font packages (Step 7).

### Issue: "YouTube notifications not working"

- ✅ `YOUTUBE_API_KEY` in `.env`
- ✅ YouTube Data API v3 enabled in Google Cloud Console
- ✅ Channel subscribed successfully (`/youtube list`)

## Verifying Installation

Test each feature:

```bash
# Public commands (anyone)
/xp                    # View your XP
/leaderboard          # Show top 10

# Admin commands (Manage Guild only)
/settings            # View configuration
/setxp message:5     # Update settings
```

### Expected Results

**`/settings` should show**:
```
**XP:** msg=5, reaction=2, voice/min=1
**Cooldowns:** msg=20s, reaction=10s
**Decay:** enabled=true/false...
**Level→Role mappings:** (none or configured)
**Commands allowed in:** All channels...
```

## Next Steps

After setup is complete:
1. Configure XP rates to match your server's pace
2. Set up role mappings for level-based access control
3. Enable decay if you want to prevent XP hoarding
4. Subscribe to YouTube channels if using that feature
5. Use `/setcommandchannel` to organize command locations

## Support

- Check logs for errors: `npm start` output
- View README.md in project root
- Review GitHub issues for similar problems
