# Editor state (`@/state`)

Everything the editor knows lives in one Zustand 5 vanilla store with Immer patches. Import
from `@/state/index.ts` only — it is the public, stable API for the timeline, panels and
inspector.

```ts
import { editorStore, useClip, useSelection, usePlayhead } from '@/state/index.ts'
```

## Shape (`EditorState`)

| Field            | Type                   | Notes                                                                    |
| ---------------- | ---------------------- | ------------------------------------------------------------------------ |
| `project`        | `Project \| null`      | Deep-frozen Immer tree. Never mutate; edit through `dispatch`.           |
| `assets`         | `Record<id, Asset>`    | Kept fresh by WS `asset` events (proxy ready, probe results).            |
| `selection`      | `{ clipIds, trackId }` | Pruned automatically when clips/tracks disappear (undo, remote edits).   |
| `playhead`       | `Us`                   | Integer µs, ≥ 0.                                                         |
| `playheadSource` | `'user' \| 'engine'`   | `'user'` moves seek the preview; `'engine'` moves come from playback.    |
| `playing`        | `boolean`              | The preview binding plays/pauses the engine from this.                   |
| `zoom`           | `number`               | Timeline px per second, clamped to `ZOOM_MIN..ZOOM_MAX` (8..2400).       |
| `scroll`         | `{ x, y }`             | Timeline scroll offset in px (owned by the timeline).                    |
| `activeTool`     | `string \| null`       | Highlighted tool (owned by panels).                                      |
| `activePanel`    | `string \| null`       | Open panel/sheet id. `MEDIA_PANEL` (`'media'`) is the media library.     |
| `history`        | `HistoryFlags`         | `canUndo/canRedo/undoLabel/redoLabel` — the only history UI needs.       |
| `transaction`    | `string \| null`       | Label of the open gesture.                                               |
| `sync`           | `SyncInfo`             | `status` (`idle/pending/saving/saved/offline/error`), `revision`, error. |

## Editing: `dispatch(label, recipe, opts?)`

Every project change goes through `dispatch`. The recipe receives an Immer draft — call core
ops on it — and the store records one undo step with forward/inverse patches.

```ts
import { splitClip, setClipSpeed } from '@reelforge/core'

const [left, right] = editorStore.getState().dispatch('Split', (d) => splitClip(d, id, t))
editorStore.getState().dispatch('Speed', (d) => setClipSpeed(d, id, 2))
```

- Return values that are drafts (a new clip, `[left, right]`) come back as plain snapshots.
- If the recipe throws (e.g. `OpError`), the project is untouched and the error propagates.
  Prefer the command helpers in `@/editor/actions.ts`, which return `CommandResult`.
- A recipe that changes nothing records nothing.
- `opts.coalesce: key` merges consecutive dispatches with the same key within
  `COALESCE_MS` (1 s) into one undo step — use for typing and nudges.

## Gestures: transactions

A drag dispatches on every pointermove but must be **one** undo step and **one** autosave:

```ts
const s = editorStore.getState
onPointerDown = () => s().beginTransaction('Trim clip')
onPointerMove = () => s().dispatch('Trim clip', (d) => trimClip(d, id, { end }))
onPointerUp = () => s().commitTransaction()
onPointerCancel / Escape = () => s().cancelTransaction() // reverts the whole gesture
```

- Autosave and remote updates wait until the transaction ends.
- `undo()` during a gesture cancels the gesture. `redo()` is ignored.
- `beginTransaction` while one is open commits the open one first.

## Undo / redo

`undo()`, `redo()`, `clearHistory()`; `history` flags drive buttons. History holds up to
`HISTORY_LIMIT` (300) steps. If a remote change makes old patches inapplicable, history is
cleared rather than corrupting the project.

## Selection, playhead, UI

`select(ids, { additive?, trackId? })`, `toggleSelect(id)`, `selectTrack(id)`,
`clearSelection()`, `setPlayhead(t, source = 'user')`, `setPlaying`, `togglePlaying`,
`setZoom(pxPerSec)`, `zoomBy(factor)`, `setScroll({ x?, y? })`, `setActiveTool`,
`setActivePanel`. Redundant updates do not notify subscribers.

**Playback contract:** while playing, the preview engine writes the playhead at display
rate with `source: 'engine'`. Anything the user does (scrub, tap the ruler, frame step)
must call `setPlayhead(t)` (default `'user'`), which seeks the engine.

## Reading state without re-renders

Hooks in `selectors.ts` subscribe to the smallest slice:

| Hook                                                       | Re-renders when                       |
| ---------------------------------------------------------- | ------------------------------------- |
| `useClip(id)`                                              | that clip object changes              |
| `useTrack(id)` / `useTrackIds()`                           | that track / the list of track ids    |
| `useIsSelected(id)`                                        | that clip's selected flag flips       |
| `usePlayhead()`                                            | every frame while playing — isolate!  |
| `useSelection()`, `useSelectedClip()`                      | selection / the single selected clip  |
| `useZoom()`, `usePlaying()`, `useDuration()`               | that value                            |
| `useAsset(id)`, `useAssetsMap()`                           | that asset / any asset                |
| `useHistoryFlags()`, `useSyncInfo()`, `useInTransaction()` | that value                            |
| `useEditor(sel)` / `useEditorShallow(sel)`                 | custom selector (Object.is / shallow) |

Because the project is structurally shared, a clip component using `useClip(id)` does not
re-render when a sibling changes. Put `usePlayhead()` only in tiny leaf components (the
playhead line, the timecode); for 60 fps visuals prefer `editorStore.subscribe` and write
to a ref/style directly.

Pure helpers (no React): `clipIndex(project)` (O(1) clip lookup map, cached per project
version), `locateClip`, `clipsAt(project, t)`, `timelineEnd(project)`, `mainTrackOf`.

Event handlers should read fresh state with `editorStore.getState()` instead of closing
over hook values.

## Persistence (`sync.ts`) — handled for you

`createProjectSync` is started by the editor session (`@/editor/session.ts`); features never
call the server for project edits.

- Autosave: 500 ms after the last committed change, `PUT /api/projects/:id` with
  `{ project, expectedRevision, deviceId }`. Never mid-gesture.
- `409` → the server's project is adopted and local unsaved patches are re-applied on top
  (rebase). If they no longer apply or produce an invalid project, the server version wins
  and the user is told.
- Live sync: WS `project` events from other devices → fetch → same rebase.
- Offline: edits stay queued, are persisted to IndexedDB (`drafts`), retried with backoff
  and immediately on `online`; recovered on the next open.
- `flushProject()` from `@/editor/session.ts` resolves once the host has every edit (call
  before starting jobs that read the project, e.g. export or AI tools).

## Uploads (`uploads.ts`)

Global queue (survives navigation): `enqueueUploads(files, { projectId?, addToTimeline? })`,
`cancelUpload`, `retryUpload`, `dismissUpload`, `useUploads(selector)`, `whenSettled(ids)`.
Two files at a time; each file is uploaded in server-sized chunks (8 MB, 3 in parallel,
resumable). With `addToTimeline`, the open editor inserts finished files in pick order.

## Testing

`createEditorStore(now?)` creates an isolated store (inject a clock to test coalescing).
See `apps/web/test/state/*.test.ts` for examples.
