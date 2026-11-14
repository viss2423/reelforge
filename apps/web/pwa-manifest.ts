import type { ManifestOptions } from 'vite-plugin-pwa'

/** Web app manifest. Colours match the dark theme tokens in src/styles.css. */
export const pwaManifest: Partial<ManifestOptions> = {
  id: '/',
  name: 'ReelForge',
  short_name: 'ReelForge',
  description: 'Edit Reels, Shorts and TikToks on any device — your own computer does the work.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0b0b10',
  theme_color: '#0b0b10',
  categories: ['photo', 'productivity', 'entertainment'],
  icons: [
    { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    {
      src: '/icons/maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
  share_target: {
    action: '/share-target',
    method: 'POST',
    enctype: 'multipart/form-data',
    params: {
      title: 'title',
      text: 'text',
      files: [{ name: 'media', accept: ['video/*', 'image/*', 'audio/*'] }],
    },
  },
}
