import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import '@/app/install.ts'
import { App } from '@/app/App.tsx'
import { applyTheme, watchSystemTheme } from '@/app/theme.ts'
import { toast } from '@/components/Toast.tsx'
import './styles.css'

applyTheme()
watchSystemTheme()

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Service worker: precached shell + share target. A new deploy waits until the user agrees,
// so an edit session is never reloaded under their fingers.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const update = registerSW({
    onNeedRefresh() {
      toast('Update available', {
        duration: 0,
        action: { label: 'Reload', onClick: () => void update(true) },
      })
    },
  })
}
