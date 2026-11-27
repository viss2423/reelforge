/**
 * Server state via TanStack Query. Lists are kept fresh by WebSocket events
 * (`applyServerEvent`) rather than polling, so the UI updates the instant the host
 * finishes a proxy or an export makes progress.
 */
import type { Asset, ExportSettings, Job, ServerEvent } from '@reelforge/core'
import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { ApiError, type CreateProjectInput } from './client.ts'
import { api } from './index.ts'

export const qk = {
  health: ['health'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  assets: ['assets'] as const,
  jobs: ['jobs'] as const,
  packs: ['packs'] as const,
  trends: ['trends'] as const,
  system: ['system'] as const,
  devices: ['devices'] as const,
}

export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        // Auth and validation errors won't fix themselves; only retry transient failures.
        retry: (count, err) => count < 2 && (!(err instanceof ApiError) || err.retryable),
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  })

/** Replace-by-id or prepend. Returns the same array when nothing changed. */
export const upsertById = <T extends { id: string }>(
  list: readonly T[] | undefined,
  item: T,
): T[] | undefined => {
  if (!list) return list
  const i = list.findIndex((x) => x.id === item.id)
  if (i === -1) return [item, ...list]
  const next = list.slice()
  next[i] = item
  return next
}

/** Folds a realtime event into the query cache. */
export const applyServerEvent = (qc: QueryClient, e: ServerEvent): void => {
  switch (e.type) {
    case 'job':
      qc.setQueryData<Job[]>(qk.jobs, (l) => upsertById(l, e.job))
      if (e.job.kind === 'trends' && e.job.status !== 'queued')
        void qc.invalidateQueries({ queryKey: qk.trends })
      return
    case 'asset':
      qc.setQueryData<Asset[]>(qk.assets, (l) => upsertById(l, e.asset))
      return
    case 'project':
      void qc.invalidateQueries({ queryKey: qk.projects })
      return
    case 'packs':
      void qc.invalidateQueries({ queryKey: qk.packs })
      void qc.invalidateQueries({ queryKey: qk.trends })
      return
    case 'hello':
      return
  }
}

/** After a reconnect we may have missed events: refetch everything event-driven. */
export const refetchAfterReconnect = (qc: QueryClient): void => {
  for (const key of [qk.jobs, qk.assets, qk.projects]) void qc.invalidateQueries({ queryKey: key })
}

/* ------------------------------------------------------------------ queries */

export const useHealth = () =>
  useQuery({
    queryKey: qk.health,
    queryFn: ({ signal }) => api.health(signal),
    staleTime: 5 * 60_000,
  })

export const useProjects = () =>
  useQuery({ queryKey: qk.projects, queryFn: ({ signal }) => api.projects(signal) })

/** Assets are event-driven; never consider them stale on their own. */
export const useAssets = <T = Asset[]>(select?: (a: Asset[]) => T): UseQueryResult<T> =>
  useQuery({
    queryKey: qk.assets,
    queryFn: ({ signal }) => api.assets(signal),
    staleTime: Number.POSITIVE_INFINITY,
    select,
  })

export const useJobs = <T = Job[]>(select?: (j: Job[]) => T): UseQueryResult<T> =>
  useQuery({
    queryKey: qk.jobs,
    queryFn: ({ signal }) => api.jobs({}, signal),
    staleTime: Number.POSITIVE_INFINITY,
    select,
  })

export const isActiveJob = (j: Job): boolean => j.status === 'queued' || j.status === 'running'

/** Export jobs, newest first. */
export const selectExports = (jobs: Job[]): Job[] =>
  jobs.filter((j) => j.kind === 'export').sort((a, b) => b.createdAt.localeCompare(a.createdAt))

export const usePacks = () =>
  useQuery({
    queryKey: qk.packs,
    queryFn: ({ signal }) => api.packs(signal),
    staleTime: 10 * 60_000,
  })

export const useTrends = () =>
  useQuery({
    queryKey: qk.trends,
    queryFn: ({ signal }) => api.trends(signal),
    staleTime: 5 * 60_000,
  })

export const useSystem = () =>
  useQuery({ queryKey: qk.system, queryFn: ({ signal }) => api.system(signal), staleTime: 60_000 })

export const useDevices = () =>
  useQuery({ queryKey: qk.devices, queryFn: ({ signal }) => api.devices(signal) })

/* ------------------------------------------------------------------ mutations */

export const useCreateProject = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api.createProject(input),
    onSuccess: (p) => {
      qc.setQueryData(qk.project(p.id), p)
      void qc.invalidateQueries({ queryKey: qk.projects })
    },
  })
}

export const useDeleteProject = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: (_v, id) => {
      qc.removeQueries({ queryKey: qk.project(id) })
      void qc.invalidateQueries({ queryKey: qk.projects })
    },
  })
}

export const useDuplicateProject = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.duplicateProject(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.projects }),
  })
}

export const useStartExport = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { projectId: string; settings: ExportSettings }) =>
      api.exportProject(v.projectId, v.settings),
    onSuccess: (job) => {
      qc.setQueryData<Job[]>(qk.jobs, (l) => upsertById(l, job) ?? [job])
    },
  })
}

export const useCancelJob = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.jobs }),
  })
}

export const useDeleteAsset = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteAsset(id),
    onSuccess: (_v, id) =>
      qc.setQueryData<Asset[]>(qk.assets, (l) => l?.filter((a) => a.id !== id)),
  })
}

export const useRevokeDevice = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.revokeDevice(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.devices }),
  })
}

export const useRefreshTrends = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.refreshTrends(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.trends }),
  })
}

export const useTrendIdea = () =>
  useMutation({ mutationFn: (topic: string) => api.trendIdea(topic) })

export const useTrendSettings = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (s: { autoPublish: boolean }) => api.setTrendSettings(s),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.trends }),
  })
}

export const useSyncPacks = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.syncPacks(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.packs }),
  })
}
