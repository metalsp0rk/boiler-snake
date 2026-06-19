# HeisenXP-Bot Documentation Index

Welcome to the comprehensive documentation for HeisenXP-Bot.

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

**New to HeisenXP-Bot?**
→ Start with [Setup Guide](setup.md)

**Want to configure XP rates?**
→ See [Configuration Guide](configuration.md) then jump to [XP and Leveling](xp-and-leveling.md)

**Need YouTube notifications working?**
→ Read [YouTube Notifications](youtube-notifications.md)

**Troubleshooting a problem?**
→ Check the [FAQ](FAQ.md) first

**Want to understand how it all works?**
→ Dive into [Architecture Overview](architecture.md) and [Database Schema](database.md)

---

## 📦 Project Information

- **Version**: 1.2.0
- **License**: MIT
- **Framework**: Discord.js v14
- **Database**: SQLite with WAL mode
- **Author**: zombienerd

---

## 🔗 Additional Resources

- [README.md](../README.md) - Project overview and installation summary
- [ROADMAP.md](../ROADMAP.md) - Future features (honeypot channels, ticket system)
- [GitHub Repository](https://github.com/zombienerd/HeisenXP-Bot)

---

## 🎉 Ready to Start?

Everything you need is in this documentation:

1. **Install** the bot following [Setup Guide](setup.md)
2. **Configure** settings per your server's needs ([Configuration Guide](configuration.md))
3. **Test** XP and leveling features
4. **Customize** roles, decay, YouTube alerts as needed

Good luck, and enjoy gamifying your Discord community! 🚀
