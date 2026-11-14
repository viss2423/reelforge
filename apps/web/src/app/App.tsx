import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { api, auth } from '@/api/index.ts'
import { createQueryClient } from '@/api/queries.ts'
import { routes } from './routes.tsx'

const router = createBrowserRouter(routes)

// A 401 anywhere means the token was revoked or expired: drop it; RequireAuth re-pairs.
api.onUnauthorized = () => auth.clear()

/** App root: server-state cache + router. */
export function App() {
  const [queryClient] = useState(createQueryClient)
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
