# Boiler Snake Documentation Index

Welcome to the comprehensive documentation for Boiler Snake.

## 📚 Documentation Structure

### Getting Started
- **[Setup and Installation](setup.md)** - Complete guide to getting your bot online
  - Discord Bot creation
  - Environment configuration  
  - Permission setup
  - First-time setup wizard

- **[Configuration Guide](configuration.md)** - Customize your server's experience
  - Environment variables explanation
  - Per-guild settings
  - Command reference
  - Best practices by server type

### Core Features
- **[XP and Leveling System](xp-and-leveling.md)**
  - Multi-source XP (messages, reactions, voice)
  - Configurable level curve formula
  - Cooldown systems to prevent spam
  - XP safety mechanisms

- **[Voice XP System](voice-xp.md)**
  - Per-minute ticker mechanism
  - Eligibility rules (2+ humans, no AFK/mute/deafen)
  - Configuration examples

- **[Role Management](roles.md)**
  - Automatic role grants based on level
  - Drop grace periods to prevent immediate loss
  - Best practices for thresholds

- **[Reaction Roles](reaction-roles.md)**
  - Self-serve emoji panels with min-level gates
  - Removable options and panel deploy/sync

- **[Daily XP Decay](decay.md)**
  - Configure inactivity penalties
  - Activity threshold logic
  - Use cases and examples

### Advanced Features
- **[YouTube Notifications](youtube-notifications.md)**
  - Live stream and video upload alerts
  - API key setup
  - Subscribing to channels
  - Configuration commands

- **[Music Player](music.md)**
  - `/play` in voice via Lavalink
  - Spotify catalog (not Spotify audio streams)

- **[Honeypot Channels](honeypot.md)**
  - Decoy channels that ban anyone who posts
  - Exempt roles for staff
  - Setup order, permissions, and troubleshooting

- **[Scheduled Event Reminders](event-reminders.md)**
  - Pre-event pings for Interested members
  - Dedicated event roles and opt-out

- **[Staff Roles](staff-roles.md)**
  - Junior/senior trusted roles
  - Staff command gate and ticket visibility

- **[Staff Notes](staff-notes.md)**
  - Private staff-only notes about members
  - Never shown to the subject

- **[Warning System](warnings.md)**
  - Formal permanent disciplinary records
  - Voidable; member self-view via `/warn mine`

- **[Help Tickets](tickets.md)**
  - Private support channels, sensitive mode
  - HTML transcripts and staff archives

- **[User Activity Summary](user-activity.md)**
  - Channel/category post rankings for senior staff
  - Ignore lists and backfill

- **[Audit Log & Message Log](audit-log.md)**
  - Staff channels for moderation and role activity
  - Deleted-message embeds

- **[Leaderboard Rendering](leaderboard.md)**
  - PNG generation details
  - Color scheme and fonts
  - Unicode support
  - Customization options

- **[Command Restrictions](command-restrictions.md)**  
  - Channel-based command control
  - Self-lockout prevention
  - Use cases and examples

### Technical Documentation
- **[Commands Reference (commands/)](commands/index.md)**
  - All slash commands documented
  - Permission matrix
  - Error handling guide
  - Quick reference card

- **[Database Schema](database.md)**
  - Complete SQLite schema
  - Table specifications
  - Indexes and queries
  - Backup strategies

- **[Architecture Overview](architecture.md)**
  - File structure breakdown
  - Module responsibilities
  - Data flow diagrams (ASCII)
  - Security considerations

### Support
- **[FAQ](FAQ.md)** - Common questions answered
  - General usage
  - Troubleshooting
  - Technical details

---

## 🔍 Quick Navigation by Use Case

**New to Boiler Snake?**
→ Start with [Setup Guide](setup.md)

**Want to configure XP rates?**
→ See [Configuration Guide](configuration.md) then jump to [XP and Leveling](xp-and-leveling.md)

**Need YouTube notifications working?**
→ Read [YouTube Notifications](youtube-notifications.md)

**Setting up tickets or staff access?**
→ [Help Tickets](tickets.md) and [Staff Roles](staff-roles.md)

**Troubleshooting a problem?**
→ Check the [FAQ](FAQ.md) first

**Want to understand how it all works?**
→ Dive into [Architecture Overview](architecture.md) and [Database Schema](database.md)

---

## 📦 Project Information

- **Version**: 1.3.0
- **License**: MIT
- **Framework**: Discord.js v14
- **Database**: SQLite with WAL mode
- **Author**: zombienerd

---

## 🔗 Additional Resources

- [Project README](https://github.com/metalsp0rk/boiler-snake#readme) - Project overview and installation summary
- [GitHub Repository](https://github.com/metalsp0rk/boiler-snake)

---

## 🎉 Ready to Start?

Everything you need is in this documentation:

1. **Install** the bot following [Setup Guide](setup.md)
2. **Configure** settings per your server's needs ([Configuration Guide](configuration.md))
3. **Test** XP and leveling features
4. **Customize** roles, decay, tickets, staff tools, YouTube alerts, honeypots as needed

Good luck, and enjoy gamifying your Discord community! 🚀
