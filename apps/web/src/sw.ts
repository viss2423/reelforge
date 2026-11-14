/// <reference lib="webworker" />
/**
 * ReelForge service worker (vite-plugin-pwa `injectManifest`).
 *
 * Caching policy — deliberately narrow:
 * - The app shell (hashed JS/CSS/HTML/icons) is precached, so the app opens instantly and
 *   offline; navigations fall back to the cached index.html.
 * - Pack files (`/api/packs/files/*`: LUTs, stickers, fonts, thumbs) are content-addressed
 *   and immutable → cache-first.
 * - Everything else under `/api/*` (JSON, media, proxies, exports, WebSocket) is NEVER
 *   cached: it is live editing state or multi-GB media that would blow the storage quota
 *   and break HTTP Range streaming.
 *
 * Web Share Target: Android shares (`POST /share-target`, multipart) are intercepted here,
 * the files are parked in IndexedDB (no reading into memory: File objects are stored as
 * blobs) and the app is opened at `/share-target?id=…` to run the import flow.
 */
import { clientsClaim } from 'workbox-core'
import { ExpirationPlugin } from 'workbox-expiration'
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { putSharedBatch } from '@/lib/shareInbox.ts'

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// SPA navigations → cached shell. /api and the share-target POST are never navigations we own.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//, /^\/share-target/],
  }),
)

registerRoute(
  ({ url, request }) =>
    url.origin === self.location.origin &&
    request.method === 'GET' &&
    url.pathname.startsWith('/api/packs/files/'),
  new CacheFirst({
    cacheName: 'rf-pack-files',
    plugins: [new ExpirationPlugin({ maxEntries: 600, purgeOnQuotaError: true })],
  }),
)

/** Handles the Web Share Target POST and redirects into the app's import flow. */
const handleShare = async (request: Request): Promise<Response> => {
  try {
    const form = await request.formData()
    const files = form.getAll('media').filter((f): f is File => f instanceof File && f.size > 0)
    const title = form.get('title')
    const text = form.get('text')
    const id = await putSharedBatch({
      files,
      ...(typeof title === 'string' && title ? { title } : {}),
      ...(typeof text === 'string' && text ? { text } : {}),
    })
    return Response.redirect(`/share-target?id=${encodeURIComponent(id)}`, 303)
  } catch {
    return Response.redirect('/share-target?error=1', 303)
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (
    event.request.method === 'POST' &&
    url.origin === self.location.origin &&
    url.pathname === '/share-target'
  ) {
    event.respondWith(handleShare(event.request))
  }
})

// The page shows an "Update available" toast and posts SKIP_WAITING when the user accepts.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting()
})

clientsClaim()
