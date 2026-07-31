# Frequently Asked Questions (FAQ)

Common questions and answers for Boiler Snake users and administrators.

## General Questions

### Q: What is Boiler Snake?

**A**: A Discord bot that tracks user XP through messages, reactions, and voice activity, with automatic role management based on levels. It's designed to gamify your server and reward participation.

**Key Features**:
- Multi-source XP tracking (messages, reactions, voice)
- Level-based role granting
- Daily XP decay for inactive users
- YouTube notifications for streams/uploads
- Honeypot channels (auto-ban decoy-channel posters)
- Beautiful PNG leaderboards

---

### Q: How do I update the bot?

**A**: Follow these steps:

```bash
# Stop the current instance (Ctrl+C)
git pull origin main
npm install  # Install any new dependencies
npm start    # Restart the bot
```

If database migrations are included in the update:
- Bot will auto-run migrations on startup
- No manual intervention needed
- Check logs for migration messages

---

### Q: Can I use this bot across multiple servers?

**A**: Yes! Boiler Snake supports multi-guild operation. Each server has its own:

- XP data (separate user databases)
- Settings (XP rates, decay configs, etc.)
- Role mappings
- YouTube subscriptions
- Command channel restrictions
- Honeypot channels and exempt roles

Install once, add to multiple servers using the OAuth2 URL.

---

### Q: How do honeypot channels work?

**A**: Mark a decoy channel with `/honeypot channel add`. Anyone who posts there is DM'd (if possible), the message is deleted, and they are banned—unless they have a role from `/honeypot exempt add`.

**Important**:
- Exempt staff roles **before** enabling honeypots
- The bot needs **Ban Members** (and ideally **Manage Messages**)
- The bot’s role must be **above** members it needs to ban
- Bots are ignored; only human posters trigger bans

Full guide: [Honeypot Channels](honeypot.md).

---

## XP and Leveling Questions

### Q: My XP isn't updating. Why?

**Checklist**:

1. **Message Content Intent**: Enable in Developer Portal → Bot settings → Privileged Gateway Intents

2. **Cooldowns**: Check your cooldown settings:
   ```bash
   /settings  # View current cooldowns
   ```

3. **Test manually**: Try sending multiple messages in different channels to verify.

4. **Check logs**: Look for errors when messages are sent:
   ```
   npm start  # Watch for [MessageCreate] error messages
   ```

**Common fix**: Enable Message Content Intent in Developer Portal (required for reliable message tracking).

---

### Q: How is leveling calculated?

**A**: Using the formula:

```
Level = floor(sqrt(XP / level_xp_factor))
```

Where `level_xp_factor` defaults to 100.

**Example calculations**:
- Level 1: requires ≥ 100 XP (with factor=100)
- Level 2: requires ≥ 400 XP
- Level 3: requires ≥ 900 XP
- Level 10: requires ≥ 10,000 XP

You can adjust the curve using `/setxp level_xp_factor:<value>`.

---

### Q: Can I disable message XP but keep reaction/voice?

**A**: Yes! Use:

```bash
/setxp message:0
```

This sets message XP to 0 while keeping other sources active. Users will still earn from reactions and voice activity.

---

## Role Management Questions

### Q: Why isn't my bot granting roles?

**Checklist**:

1. **Bot permissions**: Verify "Manage Roles" is enabled in Discord Developer Portal → Bot permissions

2. **Role position**: In your server settings:
   -go to Roles
   -Find your bot's role
   -Drag it ABOVE the roles you want it to manage
   
3. **Level thresholds**: Check if user has actually reached required level with `/xp [user]`

4. **View mappings**:
   ```bash
   /leveltorole list  # Verify mapping exists
   ```

---

### Q: How does the drop grace period work?

**A**: When a user drops below their role's required level:

1. Bot marks them as "below threshold" with current timestamp
2. If they return to meeting the requirement before grace ends: Timer clears, role kept
3. If grace period expires (e.g., 7 days): Role is revoked

**Example**: User at Level 10 has @Member role (requires L5). They drop to Level 4:
- Timers starts for losing @Member role
- If within 7 days they level back to 5+: Keep role
- If 7 days pass while at Level 4: Lose @Member role

---

## Decay Questions

### Q: What happens if I disable decay?

**A**: XP accumulates indefinitely. Users can become "levellocked" by early gain without maintaining activity.

**When to disable**:
- Testing the bot
- Very small servers (10-50 active members)
- Servers with special events where XP hoarding is acceptable

---

### Q: Can I adjust decay mid-week?

**A**: Yes! Decay runs daily at 4:00 AM server time. Changes take effect at the next scheduled run.

**Example**: If you change settings at 3:00 PM Tuesday, new settings apply Thursday at 4:00 AM (when Wednesday's decay runs).

---

### Q: Do I have to wait until 4 AM for decay to take effect?

**A**: Not if you're testing! You can manually trigger by updating XP in the database:

```sql
-- Get current XP
SELECT xp FROM users WHERE guild_id='...' AND user_id='...';

-- Manually reduce (simulating decay)
UPDATE users SET xp=500 WHERE guild_id='...' AND user_id='...';
```

**Note**: This bypasses the normal activity check—only use for testing.

---

## YouTube Notifications Questions

### Q: Where do I get a YouTube API key?

**A**: Follow these steps:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Navigate to APIs & Services → Library
4. Search "YouTube Data API v3" and click Enable
5. Go to Credentials → Create credentials → API key
6. Copy the key to your `.env` file as `YOUTUBE_API_KEY`

---

### Q: The bot can't find my subscribed channel

**A**: Common causes:

1. **@username not resolved yet**: First subscription may take time to resolve @username to numeric ID
2. **Channel doesn't exist**: Double-check the URL
3. **API limit exceeded**: Wait 24 hours for quota reset or reduce polling interval

---

### Q: Can I get notifications only for live streams (no videos)?

**A**: Not directly—YouTube Data API v3 fetches both. However, you can:

1. Subscribe via `/youtube add`
2. The bot posts both types of alerts
3. Have moderators manually ignore video-only updates
4. Future feature: Filter by type (planned)

---

## Leaderboard Questions

### Q: Why do I see "tofu blocks" instead of emoji?

**A**: Missing Unicode fonts on your host system.

**Fix (Ubuntu/Debian)**:
```bash
sudo apt install fonts-noto-core fonts-dejavu-core fonts-noto-color-emoji
```

**Alternative (Alpine)**:
```bash
sudo apk add noto-fonts ttf-dejavu
```

---

### Q: Can I customize the leaderboard appearance?

**A**: Yes, in `src/renderLeaderboard.js`:

```javascript
// Background colors (lines 79-80)
const bg0 = "#070A12";  // Change hex values
const bg1 = "#0B1224";

// Row dimensions (line 61)
const rowStep = 70;     // Increase for more spacing

// Font stack (lines 9-25)
const FONT_STACK = [
  '"Noto Sans"',
  // Add custom fonts here
];
```

---

## Technical Questions

### Q: Where is my data stored?

**A**: All data is in a SQLite database file:
```
boiler-snake/xpbot.sqlite
```

This single file contains:
- User XP totals
- Activity logs
- Settings per guild
- Role mappings
- YouTube subscriptions
- Command restrictions

---

### Q: How do I back up my bot's data?

**A**: Simple backup for SQLite:

```bash
# Stop the bot first
npm stop  # or Ctrl+C

# Copy database file
cp xpbot.sqlite xpbot.backup.$(date +%Y%m%d).sqlite

# Resume
npm start
```

For automated backup (Linux cron):
```bash
crontab -e

# Add: daily at midnight
0 0 * * * cp /path/to/xpbot.sqlite /backup/xpbot-$(date +\%Y\%m\%d).sqlite
```

---

### Q: Can I run multiple instances of the bot?

**A**: No—each instance needs exclusive access to `xpbot.sqlite`. SQLite doesn't support multiple writers.

**Alternatives**:
- Use one bot instance with multiple servers (supported natively)
- Deploy separate Boiler Snake installations in different directories with separate `.env` and database files

---

## Performance Questions

### Q: My bot is laggy on a large server. What can I do?

**Optimizations**:

1. **Disable decay**: 
   ```bash
   /setdecay enabled:false
   ```

2. **Reduce polling frequency** (if using YouTube):
   ```bash
   /setyoutube interval 30  # Check every 30 minutes instead of 5
   ```

3. **Clean up old activity logs**:
   ```sql
   DELETE FROM activity_log WHERE created_at < (strftime('%s','now') - 86400*90) * 1000;
   ```

---

### Q: How much memory does the bot use?

**Approximate baseline** (no decay):
- Bot process: 20-30 MB RAM
- Cooldown maps: <1 MB
- Voice states in cache: ~50 KB per active voice user

With daily decay:
- Activity logs grow ~100 bytes/user/day
- No automatic purge—run `VACUUM;` periodically for old servers

---

## Support Questions

### Q: Where can I get help?

**Resources**:

1. Read this documentation (home / sidebar)
2. Check the [project README](https://github.com/metalsp0rk/boiler-snake#readme)
3. Review [GitHub issues](https://github.com/metalsp0rk/boiler-snake/issues) for similar problems
4. Examine logs when bot starts: `npm start`

**When asking for help**:
- Include bot version (check package.json)
- Mention your server size
- Share relevant settings outputs (`/settings`)
- Include error messages from logs

---

### Q: Is there a roadmap for future features?

**A**: Yes! See [`ROADMAP.md`](https://github.com/metalsp0rk/boiler-snake/blob/main/ROADMAP.md) in the project root:

**Planned features** (see roadmap if present):
- Guild staff roles (admin gate; generalizes honeypot exempt roles)
- Ticket system (support requests)
- Twitch stream notifications (multi-channel go-live alerts + dedicated ping role)
- Staff notes (private mod context) + warning system (permanent formal record)
- Activity analytics dashboard
- XP transfer between servers

**Recently added**: [Scheduled event reminders](event-reminders.md); [Honeypot channels](honeypot.md)

---

### Q: How do I report a bug?

**Steps**:

1. Check if already reported in GitHub issues
2. If not, create new issue with:
   - Bot version and Discord bot framework version
   - Node.js version (`node --version`)
   - Steps to reproduce
   - Expected vs actual behavior
   - Relevant logs or screenshots

---

## License & Credits

### Q: What license is this under?

**A**: MIT License. See the [`LICENSE`](https://github.com/metalsp0rk/boiler-snake/blob/main/LICENSE) file for details.

**Key points**:
- Free to use and modify
- Must include original copyright notice
- No warranty provided

---

### Q: Who created this bot?

**A**: Original bot by zombienerd, released on GitHub with contributions from the community.

**Disclaimer in README**:
> GPT 5.2 was used for debugging and assisting with creation of the leaderboard extents. Bot logo was AI generated.
