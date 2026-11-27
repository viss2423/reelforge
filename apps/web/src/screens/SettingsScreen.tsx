import {
  Cpu,
  Download,
  LogOut,
  MonitorSmartphone,
  Package,
  RefreshCw,
  Share,
  Smartphone,
  TrendingUp,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { auth, deviceId } from '@/api/index.ts'
import {
  useDevices,
  useHealth,
  usePacks,
  useRefreshTrends,
  useRevokeDevice,
  useSyncPacks,
  useSystem,
  useTrendSettings,
  useTrends,
} from '@/api/queries.ts'
import { sourceLabel } from '@/lib/trends.ts'
import { promptInstall, useInstallState } from '@/app/install.ts'
import { setThemePref, useThemePref, type ThemePref } from '@/app/theme.ts'
import { Button } from '@/components/Button.tsx'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { Skeleton } from '@/components/Skeleton.tsx'
import { toast } from '@/components/Toast.tsx'
import { formatBytes, formatRelative } from '@/lib/format.ts'
import { AppFrame, SectionTitle } from './AppFrame.tsx'

/** Settings: appearance, install, host info, paired devices, packs, storage, about. */
export function SettingsScreen() {
  return (
    <AppFrame title="Settings">
      <div className="grid gap-x-6 lg:grid-cols-2">
        <div>
          <Appearance />
          <Install />
          <Devices />
        </div>
        <div>
          <Host />
          <Packs />
          <TrendsSection />
          <Storage />
          <About />
        </div>
      </div>
    </AppFrame>
  )
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
      {children}
    </div>
  )
}

/** A label/value row; values wrap instead of overflowing on phones. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-2.5">
      <span className="shrink-0 text-sm text-muted">{label}</span>
      <span className="min-w-0 text-right text-sm font-medium break-words">{children}</span>
    </div>
  )
}

const DASH = '—'

function Appearance() {
  const pref = useThemePref()
  return (
    <>
      <SectionTitle>Appearance</SectionTitle>
      <SegmentedControl<ThemePref>
        label="Theme"
        value={pref}
        onChange={setThemePref}
        options={[
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
          { value: 'system', label: 'System' },
        ]}
      />
    </>
  )
}

function Install() {
  const state = useInstallState()
  if (state === 'unsupported') return null
  return (
    <>
      <SectionTitle>App</SectionTitle>
      <Card>
        <div className="flex items-center gap-3 p-4">
          <MonitorSmartphone size={22} className="shrink-0 text-violet" />
          {state === 'installed' ? (
            <p className="text-sm">ReelForge is installed on this device.</p>
          ) : state === 'available' ? (
            <>
              <p className="flex-1 text-sm">
                Install ReelForge for a full-screen, app-like editor.
              </p>
              <Button
                variant="primary"
                icon={<Download size={18} />}
                onClick={() => void promptInstall()}
              >
                Install app
              </Button>
            </>
          ) : (
            <p className="text-sm">
              To install on iPhone or iPad: tap <Share size={14} className="inline align-[-2px]" />{' '}
              Share in Safari, then <b>Add to Home Screen</b>.
            </p>
          )}
        </div>
      </Card>
    </>
  )
}

function Devices() {
  const devices = useDevices()
  const revoke = useRevokeDevice()
  const navigate = useNavigate()
  const me = deviceId()
  const signOut = () => {
    auth.clear()
    void navigate('/pair', { replace: true })
  }
  return (
    <>
      <SectionTitle>Paired devices</SectionTitle>
      <Card>
        {devices.isPending ? (
          <div className="p-4">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : devices.isError ? (
          <p className="p-4 text-sm text-danger">{devices.error.message}</p>
        ) : (
          devices.data.map((d) => {
            const current = d.current ?? d.id === me
            return (
              <div key={d.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                <Smartphone size={20} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {d.name}
                    {current && <span className="ml-2 text-xs text-accent">This device</span>}
                  </p>
                  {d.lastSeenAt && (
                    <p className="text-xs text-muted">Active {formatRelative(d.lastSeenAt)}</p>
                  )}
                </div>
                {!current && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    loading={revoke.isPending && revoke.variables === d.id}
                    onClick={() =>
                      revoke.mutate(d.id, {
                        onSuccess: () => toast.success(`${d.name} removed`),
                        onError: (e) => toast.error('Could not remove device', e.message),
                      })
                    }
                  >
                    Revoke
                  </Button>
                )}
              </div>
            )
          })
        )}
        <div className="p-3">
          <Button
            variant="ghost"
            className="text-danger"
            icon={<LogOut size={18} />}
            onClick={signOut}
          >
            Forget this device
          </Button>
        </div>
      </Card>
    </>
  )
}

function Host() {
  const sys = useSystem()
  const s = sys.data
  const encoders = s?.hwEncoders
    ? Object.entries(s.hwEncoders)
        .filter(([, v]) => typeof v === 'string' && v)
        .map(([, v]) => v as string)
    : []
  return (
    <>
      <SectionTitle>Host computer</SectionTitle>
      <Card>
        {sys.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : sys.isError ? (
          <p className="p-4 text-sm text-danger">{sys.error.message}</p>
        ) : (
          <>
            {s?.hostname && <Row label="Name">{s.hostname}</Row>}
            <Row label="CPU">
              <Cpu size={14} className="mr-1 inline align-[-2px]" />
              {s?.cpu ? `${s.cpu.model} · ${s.cpu.threads} threads` : DASH}
            </Row>
            <Row label="GPU">{s?.gpu ?? DASH}</Row>
            <Row label="GPU encoders">
              {encoders.length ? encoders.join(', ') : 'None (CPU encoding)'}
            </Row>
            {s?.memory && <Row label="Memory">{formatBytes(s.memory.total)}</Row>}
            <Row label="Disk free">
              {s?.disk ? `${formatBytes(s.disk.free)} of ${formatBytes(s.disk.total)}` : DASH}
            </Row>
            <Row label="FFmpeg">{s?.ffmpegVersion ?? DASH}</Row>
            <Row label="Speech models">
              {s?.whisper?.installed ? s.whisper.models.join(', ') || 'None' : 'Not installed'}
            </Row>
            <Row label="AI language model">
              {s?.llm?.installed
                ? (s.llm.model ?? 'Installed').replace(/\.gguf$/i, '')
                : 'Not installed (run pnpm bootstrap)'}
            </Row>
            {s?.tailscale?.hostname && <Row label="Tailscale">{s.tailscale.hostname}</Row>}
            {s?.urls?.length ? (
              <Row label="Addresses">
                {s.urls.map((u) => (
                  <span key={u} className="block font-mono text-xs">
                    {u}
                  </span>
                ))}
              </Row>
            ) : null}
          </>
        )}
      </Card>
    </>
  )
}

function Packs() {
  const packs = usePacks()
  const sync = useSyncPacks()
  const idx = packs.data?.index
  return (
    <>
      <SectionTitle>Trend packs</SectionTitle>
      <Card>
        <Row label="Version">{idx?.version ?? DASH}</Row>
        <Row label="Updated">{idx ? formatRelative(idx.updatedAt) : DASH}</Row>
        <Row label="Packs">
          <Package size={14} className="mr-1 inline align-[-2px]" />
          {idx ? idx.packs.length : DASH}
        </Row>
        <div className="p-3">
          <Button
            icon={<RefreshCw size={18} />}
            loading={sync.isPending}
            onClick={() =>
              sync.mutate(undefined, {
                onSuccess: () => toast.success('Checking for new trends…'),
                onError: (e) => toast.error('Update check failed', e.message),
              })
            }
          >
            Check for updates
          </Button>
        </div>
      </Card>
    </>
  )
}

/** Trend engine: last refresh, per-source status, refresh now, auto-publish to GitHub. */
function TrendsSection() {
  const trends = useTrends()
  const refresh = useRefreshTrends()
  const settings = useTrendSettings()
  const t = trends.data
  const autoPublish = t?.settings.autoPublish ?? false
  return (
    <>
      <SectionTitle>Trends</SectionTitle>
      <Card>
        {trends.isPending ? (
          <div className="p-4">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : trends.isError ? (
          <p className="p-4 text-sm text-danger">{trends.error.message}</p>
        ) : t ? (
          <>
            <Row label="Last refresh">
              <TrendingUp size={14} className="mr-1 inline align-[-2px]" />
              {t.running ? 'Running now…' : t.generatedAt ? formatRelative(t.generatedAt) : 'Never'}
            </Row>
            {t.nextRunAt && !t.running && <Row label="Next run">{formatRelative(t.nextRunAt)}</Row>}
            {t.lastError && <Row label="Last error">{t.lastError}</Row>}
            <Row label="Local AI">
              {t.llm.used ? 'Writing new presets' : 'Ranking + beat remixes'}
            </Row>
            <div className="px-4 py-2.5" data-testid="trend-sources">
              <p className="mb-1.5 text-sm text-muted">Sources</p>
              <ul className="flex flex-col gap-1">
                {t.sources.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={
                          s.state === 'ok'
                            ? 'size-2 rounded-full bg-success'
                            : s.state === 'error'
                              ? 'size-2 rounded-full bg-danger'
                              : 'size-2 rounded-full bg-line'
                        }
                      />
                      {sourceLabel(s.id)}
                    </span>
                    <span
                      className="min-w-0 truncate text-right text-xs text-muted"
                      title={s.error}
                    >
                      {s.state === 'ok'
                        ? `${s.items} items`
                        : s.state === 'disabled'
                          ? (s.error ?? 'Off')
                          : 'Unavailable'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-2.5">
              <span className="text-sm">
                Auto-publish to GitHub
                {!t.publishAvailable && (
                  <span className="block text-xs text-muted">
                    Set PUBLISH_TRENDS=github on the host
                  </span>
                )}
                {t.publish && (
                  <span className="block text-xs text-muted">
                    {t.publish.status} {formatRelative(t.publish.at)}
                  </span>
                )}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={autoPublish}
                aria-label="Auto-publish trends"
                disabled={!t.publishAvailable || settings.isPending}
                onClick={() =>
                  settings.mutate(
                    { autoPublish: !autoPublish },
                    { onError: (e) => toast.error('Could not save', e.message) },
                  )
                }
                className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-40 ${autoPublish ? 'bg-accent' : 'bg-surface-3'}`}
              >
                <span
                  className={`absolute top-0.5 size-6 rounded-full bg-white transition-[left] ${autoPublish ? 'left-[22px]' : 'left-0.5'}`}
                />
              </button>
            </div>
            <div className="p-3">
              <Button
                icon={<RefreshCw size={18} />}
                loading={refresh.isPending || t.running}
                onClick={() =>
                  refresh.mutate(undefined, {
                    onSuccess: () => toast.success('Refreshing trends…'),
                    onError: (e) => toast.error('Could not refresh trends', e.message),
                  })
                }
              >
                Refresh now
              </Button>
            </div>
          </>
        ) : null}
      </Card>
    </>
  )
}

function Storage() {
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null)
  useEffect(() => {
    // Absent on insecure origins (plain-HTTP LAN access).
    if (typeof navigator.storage?.estimate !== 'function') return
    let alive = true
    void navigator.storage
      .estimate()
      .then((e) => {
        if (alive) setEstimate(e)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  return (
    <>
      <SectionTitle>Storage on this device</SectionTitle>
      <Card>
        <Row label="App cache">
          {estimate?.usage !== undefined
            ? `${formatBytes(estimate.usage)}${estimate.quota ? ` of ${formatBytes(estimate.quota)}` : ''}`
            : DASH}
        </Row>
        <p className="px-4 py-3 text-xs text-muted">
          Your media and exports live on the host. This device only keeps the app and trend-pack
          files.
        </p>
      </Card>
    </>
  )
}

function About() {
  const health = useHealth()
  return (
    <>
      <SectionTitle>About</SectionTitle>
      <Card>
        <Row label="App version">{__APP_VERSION__}</Row>
        <Row label="Server version">{health.data?.version ?? DASH}</Row>
        <p className="px-4 py-3 text-xs text-muted">
          ReelForge is open-source and self-hosted: your videos never leave your own computer.
        </p>
      </Card>
    </>
  )
}
