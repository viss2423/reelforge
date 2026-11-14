/**
 * Editor store: the open project, its assets and all editor UI state, with patch-based
 * undo/redo. See ./README.md for the full contract used by the timeline, panels and
 * inspector.
 *
 * Design notes
 * - The project is an immutable (deep-frozen) Immer tree. Every edit goes through
 *   `dispatch(label, recipe)`, which runs the recipe (usually a core op) on a draft and
 *   records the forward/inverse patches. Structural sharing means unchanged tracks/clips
 *   keep their identity, so fine-grained selectors only re-render what changed.
 * - History, the open transaction and change listeners live in the closure, not in state:
 *   they change on every edit and nothing should re-render because of them. Components read
 *   the derived `history` flags instead.
 * - A transaction groups many dispatches (e.g. every pointermove of a drag) into ONE undo
 *   step and ONE autosave; `cancelTransaction` reverts the gesture.
 */
import type { Asset, Project, Us } from '@reelforge/core'
import {
  applyPatches,
  current,
  enablePatches,
  freeze,
  isDraft,
  produce,
  produceWithPatches,
  type Draft,
  type Patch,
} from 'immer'
import { createStore, type StoreApi } from 'zustand/vanilla'

enablePatches()

/** Timeline zoom limits in pixels per second. */
export const ZOOM_MIN = 8
export const ZOOM_MAX = 2400
export const ZOOM_DEFAULT = 120
export const HISTORY_LIMIT = 300
/** Dispatches sharing a `coalesce` key within this window merge into one undo step. */
export const COALESCE_MS = 1000

export interface Selection {
  clipIds: readonly string[]
  trackId: string | null
}

/** Who moved the playhead: the user (→ preview must seek) or the playing engine. */
export type PlayheadSource = 'user' | 'engine'

export type SyncStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'offline' | 'error'

export interface SyncInfo {
  status: SyncStatus
  /** Last revision acknowledged by the server. */
  revision: number
  lastSavedAt: number | null
  error: string | null
}

export interface HistoryFlags {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

export interface HistoryEntry {
  label: string
  patches: Patch[]
  inversePatches: Patch[]
  coalesce?: string | undefined
  at: number
}

export type ChangeSource = 'dispatch' | 'transaction' | 'undo' | 'redo'

/** Emitted after every committed project change (not for transaction steps or remote loads). */
export interface ProjectChange {
  label: string
  source: ChangeSource
  patches: readonly Patch[]
  inversePatches: readonly Patch[]
}

export interface DispatchOptions {
  /** Merge with the previous undo step if it has the same key and is recent (typing, nudges). */
  coalesce?: string
}

export interface EditorState {
  project: Project | null
  assets: Readonly<Record<string, Asset>>
  selection: Selection
  playhead: Us
  playheadSource: PlayheadSource
  playing: boolean
  /** Pixels per second. */
  zoom: number
  /** Timeline scroll offset in px. */
  scroll: { x: number; y: number }
  /** Tool highlighted in the tool bar (owned by panels). */
  activeTool: string | null
  /** Open panel / sheet id (owned by panels). */
  activePanel: string | null
  history: HistoryFlags
  /** Label of the open transaction, or null. */
  transaction: string | null
  sync: SyncInfo
}

export interface EditorActions {
  /** Opens a project: resets history, selection, playhead and sync info. */
  load(project: Project, assets?: readonly Asset[]): void
  /** Closes the project (leaving the editor). */
  unload(): void
  /**
   * Replaces the project without recording history (used by live sync / conflict rebase).
   * History is kept; if a later undo no longer applies, history is cleared.
   */
  replaceProject(project: Project): void
  /** Sets the server revision after a successful save (no history, no change event). */
  setRevision(revision: number): void
  /**
   * Runs `recipe` on a draft of the project and records one undo step labelled `label`.
   * Returns the recipe's result (drafts are converted to plain snapshots). Throws if no
   * project is loaded or if the recipe throws (the project is then left untouched).
   */
  dispatch<R>(label: string, recipe: (draft: Draft<Project>) => R, opts?: DispatchOptions): R
  /** Starts grouping dispatches into one undo step (e.g. on pointerdown of a drag). */
  beginTransaction(label: string): void
  /** Ends the group; records it as a single undo step if anything changed. */
  commitTransaction(): void
  /** Reverts everything dispatched since `beginTransaction`. */
  cancelTransaction(): void
  undo(): void
  redo(): void
  clearHistory(): void
  /** Subscribe to committed project changes (autosave). Returns unsubscribe. */
  subscribeChanges(listener: (change: ProjectChange) => void): () => void

  select(clipIds: readonly string[], opts?: { additive?: boolean; trackId?: string | null }): void
  toggleSelect(clipId: string): void
  selectTrack(trackId: string | null): void
  clearSelection(): void

  setPlayhead(t: Us, source?: PlayheadSource): void
  setPlaying(playing: boolean): void
  togglePlaying(): void
  setZoom(pxPerSecond: number): void
  zoomBy(factor: number): void
  setScroll(scroll: Partial<{ x: number; y: number }>): void
  setActiveTool(tool: string | null): void
  setActivePanel(panel: string | null): void

  setAssets(assets: readonly Asset[]): void
  upsertAsset(asset: Asset): void
  removeAsset(assetId: string): void

  setSync(patch: Partial<SyncInfo>): void
}

export type EditorStore = EditorState & EditorActions
export type EditorStoreApi = StoreApi<EditorStore>

const EMPTY_SELECTION: Selection = { clipIds: [], trackId: null }
const NO_HISTORY: HistoryFlags = {
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
}

const initialState = (): EditorState => ({
  project: null,
  assets: {},
  selection: EMPTY_SELECTION,
  playhead: 0,
  playheadSource: 'user',
  playing: false,
  zoom: ZOOM_DEFAULT,
  scroll: { x: 0, y: 0 },
  activeTool: null,
  activePanel: null,
  history: NO_HISTORY,
  transaction: null,
  sync: { status: 'idle', revision: 0, lastSavedAt: null, error: null },
})

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Drops selected clip ids that no longer exist (after undo, delete, remote changes). */
const pruneSelection = (sel: Selection, project: Project | null): Selection => {
  if (!project) return EMPTY_SELECTION
  const trackOk = sel.trackId === null || project.tracks.some((t) => t.id === sel.trackId)
  if (sel.clipIds.length === 0) return trackOk ? sel : { ...sel, trackId: null }
  const alive = new Set<string>()
  for (const t of project.tracks) for (const c of t.clips) alive.add(c.id)
  const clipIds = sel.clipIds.filter((id) => alive.has(id))
  if (clipIds.length === sel.clipIds.length && trackOk) return sel
  return { clipIds, trackId: trackOk ? sel.trackId : null }
}

/** Converts a recipe result that is (or is an array of) Immer drafts into plain snapshots. */
const snapshotResult = (r: unknown): unknown => {
  if (isDraft(r)) return current(r)
  if (Array.isArray(r) && r.some(isDraft))
    return r.map((x: unknown) => (isDraft(x) ? current(x) : x))
  return r
}

const assetMap = (assets: readonly Asset[]): Record<string, Asset> => {
  const m: Record<string, Asset> = {}
  for (const a of assets) m[a.id] = a
  return m
}

/** Creates an isolated editor store (the app uses the `editorStore` singleton). */
export const createEditorStore = (now: () => number = Date.now): EditorStoreApi => {
  let past: HistoryEntry[] = []
  let future: HistoryEntry[] = []
  /**
   * Open transaction. Inverse patches are kept per step (in order) and flattened in reverse
   * on commit/cancel, so a long drag stays O(steps) instead of re-copying on every move.
   */
  let tx: { label: string; patches: Patch[]; inverseSteps: Patch[][] } | null = null
  const txInverse = (t: NonNullable<typeof tx>): Patch[] => t.inverseSteps.toReversed().flat()
  const changeListeners = new Set<(c: ProjectChange) => void>()

  const flags = (): HistoryFlags => {
    const u = past.at(-1)
    const r = future.at(-1)
    return { canUndo: !!u, canRedo: !!r, undoLabel: u?.label ?? null, redoLabel: r?.label ?? null }
  }
  const emit = (c: ProjectChange) => {
    for (const l of changeListeners) l(c)
  }

  return createStore<EditorStore>()((set, get) => {
    /** Commit a new project produced by an edit; keeps selection valid. */
    const commitProject = (project: Project, extra: Partial<EditorState> = {}) =>
      set((s) => ({ project, selection: pruneSelection(s.selection, project), ...extra }))

    const resetHistory = () => {
      past = []
      future = []
      tx = null
    }

    return {
      ...initialState(),

      load(project, assets) {
        resetHistory()
        set({
          ...initialState(),
          project: freeze(project, true),
          assets: assets ? assetMap(assets) : get().assets,
          sync: { status: 'idle', revision: project.revision, lastSavedAt: null, error: null },
        })
      },

      unload() {
        resetHistory()
        set(initialState())
      },

      replaceProject(project) {
        commitProject(freeze(project, true))
      },

      setRevision(revision) {
        const { project } = get()
        set((s) => ({
          project: project
            ? produce(project, (d) => {
                d.revision = revision
              })
            : null,
          sync: { ...s.sync, revision },
        }))
      },

      dispatch(label, recipe, opts) {
        const { project } = get()
        if (!project) throw new Error(`dispatch("${label}") without a loaded project`)
        let result: unknown
        const [next, patches, inversePatches] = produceWithPatches(project, (d) => {
          // Results that are drafts (e.g. a newly inserted clip, or the [left, right] pair
          // from splitClip) would be revoked proxies after produce returns; hand back plain
          // snapshots instead. Nothing is returned from the producer, so Immer never treats
          // the result as a replacement project.
          result = snapshotResult(recipe(d))
        })
        if (patches.length === 0) return result as ReturnType<typeof recipe>
        if (tx) {
          tx.patches.push(...patches)
          tx.inverseSteps.push(inversePatches)
          commitProject(next)
          return result as ReturnType<typeof recipe>
        }
        const t = now()
        const last = past.at(-1)
        if (opts?.coalesce && last?.coalesce === opts.coalesce && t - last.at < COALESCE_MS) {
          last.patches.push(...patches)
          last.inversePatches = [...inversePatches, ...last.inversePatches]
          last.at = t
        } else {
          past.push({ label, patches, inversePatches, coalesce: opts?.coalesce, at: t })
          if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT)
        }
        future = []
        commitProject(next, { history: flags() })
        emit({ label, source: 'dispatch', patches, inversePatches })
        return result as ReturnType<typeof recipe>
      },

      beginTransaction(label) {
        if (!get().project) return
        if (tx) get().commitTransaction()
        tx = { label, patches: [], inverseSteps: [] }
        set({ transaction: label })
      },

      commitTransaction() {
        if (!tx) return
        const { label, patches } = tx
        const inverse = txInverse(tx)
        tx = null
        if (patches.length === 0) {
          set({ transaction: null })
          return
        }
        past.push({ label, patches, inversePatches: inverse, at: now() })
        if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT)
        future = []
        set({ transaction: null, history: flags() })
        emit({ label, source: 'transaction', patches, inversePatches: inverse })
      },

      cancelTransaction() {
        if (!tx) return
        const inverse = txInverse(tx)
        tx = null
        const { project } = get()
        if (project && inverse.length)
          commitProject(applyPatches(project, inverse), { transaction: null })
        else set({ transaction: null })
      },

      undo() {
        if (tx) {
          // Undo during a gesture aborts the gesture rather than undoing older work.
          get().cancelTransaction()
          return
        }
        const { project } = get()
        const entry = past.at(-1)
        if (!project || !entry) return
        let next: Project
        try {
          next = applyPatches(project, entry.inversePatches)
        } catch {
          // History no longer matches the project (remote changes replaced it).
          get().clearHistory()
          return
        }
        past.pop()
        future.push(entry)
        commitProject(next, { history: flags() })
        emit({
          label: entry.label,
          source: 'undo',
          patches: entry.inversePatches,
          inversePatches: entry.patches,
        })
      },

      redo() {
        if (tx) return
        const { project } = get()
        const entry = future.at(-1)
        if (!project || !entry) return
        let next: Project
        try {
          next = applyPatches(project, entry.patches)
        } catch {
          get().clearHistory()
          return
        }
        future.pop()
        past.push(entry)
        commitProject(next, { history: flags() })
        emit({
          label: entry.label,
          source: 'redo',
          patches: entry.patches,
          inversePatches: entry.inversePatches,
        })
      },

      clearHistory() {
        past = []
        future = []
        set({ history: NO_HISTORY })
      },

      subscribeChanges(listener) {
        changeListeners.add(listener)
        return () => changeListeners.delete(listener)
      },

      select(clipIds, opts) {
        set((s) => {
          const ids = opts?.additive
            ? [...s.selection.clipIds, ...clipIds.filter((id) => !s.selection.clipIds.includes(id))]
            : [...clipIds]
          return {
            selection: {
              clipIds: ids,
              trackId: opts?.trackId === undefined ? s.selection.trackId : opts.trackId,
            },
          }
        })
      },

      toggleSelect(clipId) {
        set((s) => {
          const has = s.selection.clipIds.includes(clipId)
          return {
            selection: {
              ...s.selection,
              clipIds: has
                ? s.selection.clipIds.filter((id) => id !== clipId)
                : [...s.selection.clipIds, clipId],
            },
          }
        })
      },

      selectTrack(trackId) {
        set((s) => ({ selection: { ...s.selection, trackId } }))
      },

      clearSelection() {
        if (get().selection !== EMPTY_SELECTION) set({ selection: EMPTY_SELECTION })
      },

      setPlayhead(t, source = 'user') {
        const playhead = Math.max(0, Math.round(t))
        const s = get()
        if (s.playhead === playhead && s.playheadSource === source) return
        set({ playhead, playheadSource: source })
      },

      setPlaying(playing) {
        if (get().playing !== playing) set({ playing })
      },

      togglePlaying() {
        set((s) => ({ playing: !s.playing }))
      },

      setZoom(pxPerSecond) {
        set({ zoom: clamp(pxPerSecond, ZOOM_MIN, ZOOM_MAX) })
      },

      zoomBy(factor) {
        set((s) => ({ zoom: clamp(s.zoom * factor, ZOOM_MIN, ZOOM_MAX) }))
      },

      setScroll(scroll) {
        set((s) => ({ scroll: { ...s.scroll, ...scroll } }))
      },

      setActiveTool(activeTool) {
        set({ activeTool })
      },

      setActivePanel(activePanel) {
        set({ activePanel })
      },

      setAssets(assets) {
        set({ assets: assetMap(assets) })
      },

      upsertAsset(asset) {
        set((s) =>
          s.assets[asset.id] === asset ? s : { assets: { ...s.assets, [asset.id]: asset } },
        )
      },

      removeAsset(assetId) {
        set((s) => {
          if (!(assetId in s.assets)) return s
          const { [assetId]: _removed, ...rest } = s.assets
          return { assets: rest }
        })
      },

      setSync(patch) {
        set((s) => ({ sync: { ...s.sync, ...patch } }))
      },
    }
  })
}

/** The editor store used by the app. */
export const editorStore: EditorStoreApi = createEditorStore()
