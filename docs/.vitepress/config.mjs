import { defineConfig } from 'vitepress'

// Project GitHub Pages site: https://metalsp0rk.github.io/boiler-snake/
// Use base: '/' if you later attach a custom domain.
export default defineConfig({
  title: 'Boiler Snake',
  description: 'XP, leveling, roles, and server tools for Discord and Fluxer',
  base: '/boiler-snake/',
  cleanUrls: true,
  lastUpdated: true,
  // GitHub-oriented index; VitePress home is docs/index.md
  srcExclude: ['README.md'],
  themeConfig: {
    logo: '/logo.png',
    siteTitle: 'Boiler Snake',
    search: {
      provider: 'local',
    },
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Setup', link: '/setup' },
      { text: 'Commands', link: '/commands/' },
      {
        text: 'Features',
        items: [
          { text: 'XP & leveling', link: '/xp-and-leveling' },
          { text: 'Staff roles', link: '/staff-roles' },
          { text: 'Tickets', link: '/tickets' },
          { text: 'Auto-moderation', link: '/automod' },
          { text: 'Web admin console', link: '/web-admin' },
          { text: 'Fluxer instances', link: '/fluxer' },
          { text: 'Channel bridges', link: '/bridge' },
          { text: 'Account linking', link: '/account-linking' },
          { text: 'Warnings', link: '/warnings' },
          { text: 'Community events', link: '/community-events' },
          { text: 'Event reminders', link: '/event-reminders' },
          { text: 'Gork', link: '/gork' },
          { text: 'Gork Logging', link: '/gork-logging' },
        ],
      },
      { text: 'FAQ', link: '/FAQ' },
      {
        text: 'GitHub',
        link: 'https://github.com/metalsp0rk/boiler-snake',
      },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Setup', link: '/setup' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Commands', link: '/commands/' },
        ],
      },
      {
        text: 'XP & progression',
        items: [
          { text: 'XP & leveling', link: '/xp-and-leveling' },
          { text: 'Voice XP', link: '/voice-xp' },
          { text: 'Roles', link: '/roles' },
          { text: 'Reaction roles', link: '/reaction-roles' },
          { text: 'Decay', link: '/decay' },
          { text: 'Leaderboard', link: '/leaderboard' },
        ],
      },
      {
        text: 'Staff & moderation',
        items: [
          { text: 'Staff roles', link: '/staff-roles' },
          { text: 'Staff notes', link: '/staff-notes' },
          { text: 'Warnings', link: '/warnings' },
          { text: 'Help tickets', link: '/tickets' },
          { text: 'Auto-moderation', link: '/automod' },
          { text: 'Web admin console', link: '/web-admin' },
          { text: 'User activity', link: '/user-activity' },
          { text: 'Audit log', link: '/audit-log' },
          { text: 'Honeypot', link: '/honeypot' },
        ],
      },
      {
        text: 'Integrations & controls',
        items: [
          { text: 'YouTube', link: '/youtube-notifications' },
          { text: 'Music', link: '/music' },
          { text: 'Twitch', link: '/twitch-notifications' },
          { text: 'RSS feeds', link: '/rss-notifications' },
          { text: 'GitHub releases', link: '/github-releases' },
          { text: 'Gork', link: '/gork' },
          { text: 'Gork Logging', link: '/gork-logging' },
          { text: 'Community events', link: '/community-events' },
          { text: 'Event reminders', link: '/event-reminders' },
          { text: 'Command restrictions', link: '/command-restrictions' },
          { text: 'Fluxer instances', link: '/fluxer' },
          { text: 'Channel bridges', link: '/bridge' },
          { text: 'Account linking', link: '/account-linking' },
        ],
      },
      {
        text: 'Technical',
        items: [
          { text: 'Database', link: '/database' },
          { text: 'Architecture', link: '/architecture' },
          { text: 'E2E Tests', link: '/e2e' },
          { text: 'FAQ', link: '/FAQ' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/metalsp0rk/boiler-snake' },
    ],
    outline: {
      level: [2, 3],
    },
    editLink: {
      pattern: 'https://github.com/metalsp0rk/boiler-snake/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
})
