# HeisenXP-Bot Documentation

A Discord bot for tracking user XP, levels, roles, and more with extensive per-guild configuration.

## Overview

HeisenXP-Bot is a feature-rich Discord bot that helps you gamify your server with:

- **Multi-source XP tracking**: Messages, reactions, and voice channel activity
- **Customizable leveling system**: Configurable XP formulas and thresholds
- **Automatic role management**: Grant or revoke roles based on level with grace periods
- **Daily XP decay**: Incentivize active participation
- **YouTube notifications**: Get alerted when subscribed channels go live or upload videos
- **Leaderboard visualization**: Beautiful PNG leaderboards with gradients and rankings

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Discord bot token and client ID

# Register slash commands (recommended: use DEV_GUILD_ID for dev)
npm run register

# Start the bot
npm start
```

See [Setup Guide](setup.md) for detailed installation instructions.

## Table of Contents

### Getting Started
- [Setup and Installation](setup.md) - Complete installation guide with video, fonts, and permission setup
- [Configuration Guide](configuration.md) - Environment variables and in-game command configuration
- [Commands Reference](commands/) - Full documentation for all slash commands

### Core Features
- [XP and Leveling System](xp-and-leveling.md) - Multi-source XP tracking and level calculation
- [Voice XP System](voice-xp.md) - Voice channel activity tracking with eligibility rules
- [Role Management](roles.md) - Automatic role grants and drops with grace periods
- [Daily XP Decay](decay.md) - Incentivize activity through daily XP reduction

### Advanced Features
- [YouTube Notifications](youtube-notifications.md) - Monitor channels for live streams and uploads
- [Leaderboard Rendering](leaderboard.md) - Beautiful PNG leaderboards with gradients
- [Command Restrictions](command-restrictions.md) - Control where commands can be used

### Technical Documentation
- [Database Schema](database.md) - Complete SQLite schema and queries
- [Architecture Overview](architecture.md) - Code structure and data flow diagrams
- [FAQ](FAQ.md) - Common questions and troubleshooting tips

## Requirements

- Node.js 16+ (Discord.js v14 requirement)
- Discord Bot Token with proper permissions
- SQLite database (auto-created on first run)

## Core Features at a Glance

| Feature | Description |
|---------|-------------|
| **Message XP** | Award XP per message with configurable cooldowns to prevent spam farming |
| **Reaction XP** | Give points for reacting to messages (reactions, reactions, and more reactions!) |
| **Voice XP** | Earn XP while in voice channels (requires ≥2 eligible humans) |
| **Level-Up Roles** | Automatically grant roles when users reach specific levels |
| **Role Drop Grace** | Keep roles temporarily after dropping below threshold (configurable days) |
| **Daily Decay** | Reduce XP for inactive users based on message count thresholds |
| **Command Channels** | Restrict where commands can be used per guild |
| **YouTube Alerts** | Monitor subscribed channels for live streams and uploads |

## License

MIT License - see [LICENSE](../LICENSE) file for details.
