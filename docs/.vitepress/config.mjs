import { defineConfig } from 'vitepress'

// Project GitHub Pages site: https://metalsp0rk.github.io/boiler-snake/
// Use base: '/' if you later attach a custom domain.
export default defineConfig({
  title: 'Boiler Snake',
  description: 'Discord XP, leveling, roles, and server tools',
  base: '/boiler-snake/',
  cleanUrls: true,
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
          { text: 'Warnings', link: '/warnings' },
          { text: 'Event reminders', link: '/event-reminders' },
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
          { text: 'User activity', link: '/user-activity' },
          { text: 'Audit log', link: '/audit-log' },
          { text: 'Honeypot', link: '/honeypot' },
        ],
      },
      {
        text: 'Integrations & controls',
        items: [
          { text: 'YouTube', link: '/youtube-notifications' },
          { text: 'Event reminders', link: '/event-reminders' },
          { text: 'Command restrictions', link: '/command-restrictions' },
        ],
      },
      {
        text: 'Technical',
        items: [
          { text: 'Database', link: '/database' },
          { text: 'Architecture', link: '/architecture' },
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
