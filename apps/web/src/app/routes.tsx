/**
 * Route table. Every screen is a lazy chunk so the initial download is only the shell
 * (router, query client, design-system primitives); the editor — by far the heaviest
 * screen — loads only when a project is opened.
 *
 * Router choice: React Router 8 (data router). It is the most widely deployed React router,
 * ships route-level `lazy()` code-splitting, scroll restoration and navigation blocking
 * built in, and adds ~20 KB gzip — TanStack Router's type-safe search params would be the
 * main draw, but this app has six routes and almost no search state.
 */
import type { RouteObject } from 'react-router'
import { RequireAuth } from './RequireAuth.tsx'
import { RootLayout } from './RootLayout.tsx'
import { RouteError } from './RouteError.tsx'
import { Splash } from './Splash.tsx'

export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <Splash />,
    children: [
      {
        path: '/pair',
        lazy: async () => ({ Component: (await import('@/screens/PairScreen.tsx')).PairScreen }),
      },
      {
        element: <RequireAuth />,
        children: [
          {
            index: true,
            lazy: async () => ({
              Component: (await import('@/screens/HomeScreen.tsx')).HomeScreen,
            }),
          },
          {
            path: '/p/:projectId',
            lazy: async () => ({
              Component: (await import('@/editor/EditorScreen.tsx')).EditorScreen,
            }),
          },
          {
            path: '/trending',
            lazy: async () => ({
              Component: (await import('@/screens/TrendingScreen.tsx')).TrendingScreen,
            }),
          },
          {
            path: '/exports',
            lazy: async () => ({
              Component: (await import('@/screens/ExportsScreen.tsx')).ExportsScreen,
            }),
          },
          {
            // Shared files need a paired device to upload to, so this sits behind auth;
            // unpaired devices pair first and come back here via ?next=.
            path: '/share-target',
            lazy: async () => ({
              Component: (await import('@/screens/ShareTargetScreen.tsx')).ShareTargetScreen,
            }),
          },
          {
            path: '/settings',
            lazy: async () => ({
              Component: (await import('@/screens/SettingsScreen.tsx')).SettingsScreen,
            }),
          },
        ],
      },
      {
        path: '*',
        lazy: async () => ({ Component: (await import('./NotFound.tsx')).NotFound }),
      },
    ],
  },
]
