import {
  ChevronDown,
  Download,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  Share,
  Smartphone,
  Sun,
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
import { promptInstall, useInstallState } from '@/app/install.ts'
import { setThemePref, useThemePref, type ThemePref } from '@/app/theme.ts'
import { Button } from '@/components/Button.tsx'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { Skeleton } from '@/components/Skeleton.tsx'
import { toast } from '@/components/Toast.tsx'
import { cn } from '@/lib/cn.ts'
import { formatBytes, formatRelative } from '@/lib/format.ts'
import { sourceLabel } from '@/lib/trends.ts'
import { AppFrame, SectionTitle } from './AppFrame.tsx'

/**
 * Settings, grouped into calm cards: look, this app, devices, your computer and content
 * updates. Everything technical (trend sources, publishing, diagnostics, storage,
 * versions) sits under "Advanced".
 */
export function SettingsScreen() {
  const [advanced, setAdvanced] = useState(false)
  return (
    <AppFrame title="Settings">
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-x-8 lg:grid-cols-2">
        <div className="min-w-0">
          <Appearance />
          <Install />
          <Devices />
        </div>
        <div className="min-w-0">
          <Host />
          <Content />
        </div>
      </div>
      <div className="mx-auto mt-8 max-w-5xl">
        <button
          type="button"
          aria-expanded={advanced}
          aria-controls="settings-advanced"
          onClick={() => setAdvanced((v) => !v)}
          className="flex h-12 w-full items-center justify-between rounded-2xl bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2"
        >
          Advanced
          <ChevronDown
            size={18}
            aria-hidden
            className={cn('text-muted transition-transform duration-200', advanced && 'rotate-180')}
          />
        </button>
        {advanced && (
          <div
            id="settings-advanced"
            className="animate-rf-rise grid grid-cols-1 gap-x-8 lg:grid-cols-2"
          >
            <div className="min-w-0">
              <TrendsAdvanced />
              <Storage />
            </div>
            <div className="min-w-0">
              <Diagnostics />
            </div>
          </div>
        )}
        <About />
      </div>
    </AppFrame>
  )
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col overflow-hidden rounded-2xl bg-surface', className)}>
      {children}
    </div>
  )
}

/** Label (plus a muted one-liner) on the left, value or control on the right. */
function Row({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-h-14 items-center justify-between gap-4 px-4 py-3', className)}>
      <div className="min-w-0">
        <div className="text-[15px] font-medium">{label}</div>
        {hint && <div className="truncate text-xs text-muted">{hint}</div>}
      </div>
      {children !== undefined && (
        <div className="min-w-0 shrink text-right text-sm break-words text-muted">{children}</div>
      )}
    </div>
  )
}

const DASH = '—'

function Appearance() {
  const pref = useThemePref()
  return (
    <>
      <SectionTitle>Look</SectionTitle>
      <SegmentedControl<ThemePref>
        label="Theme"
        value={pref}
        onChange={setThemePref}
        options={[
          {
            value: 'dark',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Moon size={15} aria-hidden /> Dark
              </span>
            ),
          },
          {
            value: 'light',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Sun size={15} aria-hidden /> Light
              </span>
            ),
          },
          {
            value: 'system',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Monitor size={15} aria-hidden /> Auto
              </span>
            ),
          },
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
        {state === 'installed' ? (
          <Row label="Installed" hint="ReelForge is on this device" />
        ) : state === 'available' ? (
          <Row label="Install the app" hint="Full screen, works like a native app">
            <Button
              size="sm"
              variant="primary"
              className="h-9 rounded-full px-4"
              icon={<Download size={16} />}
              onClick={() => void promptInstall()}
            >
              Install
            </Button>
          </Row>
        ) : (
          <Row
            label="Add to Home Screen"
            hint={
              <>
                In Safari, tap <Share size={12} className="inline align-[-1px]" /> Share, then Add
                to Home Screen
              </>
            }
          />
        )}
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
      <SectionTitle>Devices</SectionTitle>
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
              <div key={d.id} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-muted">
                  <Smartphone size={17} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-[15px] font-medium">
                    <span className="truncate">{d.name}</span>
                    {current && (
                      <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">
                        This device
                      </span>
                    )}
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
                    Remove
                  </Button>
                )}
              </div>
            )
          })
        )}
        <button
          type="button"
          onClick={signOut}
          className="flex min-h-12 items-center gap-3 px-4 text-left text-[15px] font-medium text-danger hover:bg-surface-2"
        >
          <LogOut size={18} aria-hidden />
          Forget this device
        </button>
      </Card>
    </>
  )
}

const useEncoders = () => {
  const s = useSystem().data
  return s?.hwEncoders
    ? Object.entries(s.hwEncoders)
        .filter(([, v]) => typeof v === 'string' && v)
        .map(([, v]) => v as string)
    : []
}

function Host() {
  const sys = useSystem()
  const s = sys.data
  const encoders = useEncoders()
  return (
    <>
      <SectionTitle>Your computer</SectionTitle>
      <Card>
        {sys.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : sys.isError ? (
          <p className="p-4 text-sm text-danger">{sys.error.message}</p>
        ) : (
          <>
            <Row label="Name" hint="Where your videos are edited and saved">
              {s?.hostname ?? DASH}
            </Row>
            <Row label="Free space">{s?.disk ? formatBytes(s.disk.free) : DASH}</Row>
            <Row label="Export speed" hint={encoders.length ? encoders.join(', ') : undefined}>
              {encoders.length ? 'Fast (GPU)' : 'Standard (CPU)'}
            </Row>
          </>
        )}
      </Card>
    </>
  )
}

function Content() {
  const packs = usePacks()
  const sync = useSyncPacks()
  const trends = useTrends()
  const refresh = useRefreshTrends()
  const idx = packs.data?.index
  const t = trends.data
  return (
    <>
      <SectionTitle>Content</SectionTitle>
      <Card>
        <Row
          label="Templates & effects"
          hint={idx ? `Updated ${formatRelative(idx.updatedAt)}` : undefined}
        >
          <Button
            size="sm"
            variant="ghost"
            className="h-9 rounded-full"
            icon={<RefreshCw size={15} />}
            loading={sync.isPending}
            onClick={() =>
              sync.mutate(undefined, {
                onSuccess: () => toast.success('Checking for new templates…'),
                onError: (e) => toast.error('Update check failed', e.message),
              })
            }
          >
            Check
          </Button>
        </Row>
        {t && (
          <Row
            label="Trends"
            hint={
              t.running
                ? 'Checking now…'
                : t.generatedAt
                  ? `Updated ${formatRelative(t.generatedAt)}`
                  : 'Not checked yet'
            }
          >
            <Button
              size="sm"
              variant="ghost"
              className="h-9 rounded-full"
              icon={<RefreshCw size={15} />}
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
          </Row>
        )}
      </Card>
    </>
  )
}

/** Trend engine internals: per-source status, local AI use, auto-publish to GitHub. */
function TrendsAdvanced() {
  const trends = useTrends()
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
            {t.nextRunAt && !t.running && (
              <Row label="Next check">{formatRelative(t.nextRunAt)}</Row>
            )}
            {t.lastError && <Row label="Last error">{t.lastError}</Row>}
            <Row label="Local AI">{t.llm.used ? 'Writing new presets' : 'Ranking only'}</Row>
            <div className="px-4 py-3" data-testid="trend-sources">
              <p className="mb-2 text-[15px] font-medium">Sources</p>
              <ul className="flex flex-col gap-1.5">
                {t.sources.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          'size-2 rounded-full',
                          s.state === 'ok'
                            ? 'bg-success'
                            : s.state === 'error'
                              ? 'bg-danger'
                              : 'bg-line',
                        )}
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
            <Row
              label="Auto-publish to GitHub"
              hint={
                !t.publishAvailable
                  ? 'Set PUBLISH_TRENDS=github on the computer'
                  : t.publish
                    ? `${t.publish.status} ${formatRelative(t.publish.at)}`
                    : undefined
              }
            >
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
                className={cn(
                  'relative block h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-40',
                  autoPublish ? 'bg-accent' : 'bg-surface-3',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 size-6 rounded-full bg-white transition-[left] duration-200 ease-[var(--ease-spring)]',
                    autoPublish ? 'left-[22px]' : 'left-0.5',
                  )}
                />
              </button>
            </Row>
          </>
        ) : null}
      </Card>
    </>
  )
}

function Diagnostics() {
  const sys = useSystem()
  const packs = usePacks()
  const s = sys.data
  const encoders = useEncoders()
  const idx = packs.data?.index
  return (
    <>
      <SectionTitle>Diagnostics</SectionTitle>
      <Card className="text-sm">
        <Row label="CPU">{s?.cpu ? `${s.cpu.model} · ${s.cpu.threads} threads` : DASH}</Row>
        <Row label="GPU">{s?.gpu ?? DASH}</Row>
        <Row label="GPU encoders">{encoders.length ? encoders.join(', ') : 'None'}</Row>
        {s?.memory && <Row label="Memory">{formatBytes(s.memory.total)}</Row>}
        <Row label="Disk">
          {s?.disk ? `${formatBytes(s.disk.free)} free of ${formatBytes(s.disk.total)}` : DASH}
        </Row>
        <Row label="FFmpeg">{s?.ffmpegVersion ?? DASH}</Row>
        <Row label="Speech models">
          {s?.whisper?.installed ? s.whisper.models.join(', ') || 'None' : 'Not installed'}
        </Row>
        <Row label="AI model">
          {s?.llm?.installed
            ? (s.llm.model ?? 'Installed').replace(/\.gguf$/i, '')
            : 'Not installed (run pnpm bootstrap)'}
        </Row>
        <Row label="Content packs">
          {idx ? `v${idx.version} · ${idx.packs.length} packs` : DASH}
        </Row>
        {s?.tailscale?.hostname && <Row label="Tailscale">{s.tailscale.hostname}</Row>}
        {s?.urls?.length ? (
          <Row label="Addresses">
            {s.urls.map((u) => (
              <span key={u} className="block font-mono text-xs break-all">
                {u}
              </span>
            ))}
          </Row>
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
      <SectionTitle>This device</SectionTitle>
      <Card>
        <Row label="App cache" hint="Media and exports stay on your computer">
          {estimate?.usage !== undefined ? formatBytes(estimate.usage) : DASH}
        </Row>
      </Card>
    </>
  )
}

function About() {
  const health = useHealth()
  return (
    <p className="mt-8 text-center text-xs text-muted">
      ReelForge {__APP_VERSION__}
      {health.data?.version && health.data.version !== __APP_VERSION__
        ? ` · server ${health.data.version}`
        : ''}
      <br />
      Open source and self-hosted: your videos never leave your computer.
    </p>
  )
}
