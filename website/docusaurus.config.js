// @ts-check
const path = require('path');
const { themes: prismThemes } = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'ctx-tree',
  tagline: 'Claude Code with a photographic memory',
  favicon: 'img/logo.svg',

  url: 'https://joeblackwaslike.github.io',
  baseUrl: '/ctx-tree/',

  organizationName: 'joeblackwaslike',
  projectName: 'ctx-tree',
  trailingSlash: false,

  onBrokenLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  staticDirectories: ['static', path.resolve(__dirname, '../docs')],

  markdown: {
    mermaid: true,
    hooks: { onBrokenMarkdownLinks: 'warn' },
  },

  themes: ['@docusaurus/theme-mermaid'],

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          editUrl: 'https://github.com/joeblackwaslike/ctx-tree/edit/main/website/',
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        defaultMode: 'dark',
        disableSwitch: true,
        respectPrefersColorScheme: false,
      },
      image: 'img/logo.svg',
      navbar: {
        title: 'ctx-tree',
        logo: {
          alt: 'ctx-tree logo',
          src: 'img/logo.svg',
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docs',
            position: 'left',
            label: 'Docs',
          },
          {
            href: 'pathname:///ctx-tree/how-it-works.html',
            label: 'How It Works',
            position: 'left',
          },
          {
            href: 'pathname:///ctx-tree/mini.html',
            label: 'Quick Overview',
            position: 'left',
          },
          {
            href: 'https://github.com/joeblackwaslike/ctx-tree',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Getting Started', to: '/docs/getting-started' },
              { label: 'MCP Tools', to: '/docs/reference/mcp-tools' },
              { label: 'Hooks', to: '/docs/reference/hooks' },
            ],
          },
          {
            title: 'Visualizations',
            items: [
              { label: 'How It Works', href: 'pathname:///ctx-tree/how-it-works.html' },
              { label: 'Quick Overview', href: 'pathname:///ctx-tree/mini.html' },
            ],
          },
          {
            title: 'More',
            items: [
              {
                label: 'GitHub',
                href: 'https://github.com/joeblackwaslike/ctx-tree',
              },
              {
                label: 'mcp-exec',
                href: 'https://github.com/joeblackwaslike/mcp-exec',
              },
              {
                label: 'Agent Marketplace',
                href: 'https://github.com/joeblackwaslike/agent-marketplace',
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Joe Black. Built with Docusaurus.`,
      },
      prism: {
        theme: prismThemes.dracula,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['bash', 'json', 'typescript', 'javascript'],
      },
      mermaid: {
        theme: { light: 'dark', dark: 'dark' },
      },
    }),
};

module.exports = config;
