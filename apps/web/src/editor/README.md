# Editor (`@/editor`)

`EditorScreen.tsx` (route `/p/:projectId`) owns the session, keyboard shortcuts and the
responsive shell. Three **slots** are filled by other modules; each is a directory whose
`index.tsx` exports one component. The current files are placeholders — replace them, keep
the export names and props.

| Slot      | Directory    | Export                    | Owner             |
| --------- | ------------ | ------------------------- | ----------------- |
| Timeline  | `timeline/`  | `Timeline()`              | timeline engineer |
| Tools     | `panels/`    | `ToolPanels({ variant })` | tools engineer    |
| Inspector | `inspector/` | `Inspector()`             | tools engineer    |

## Layout

```
 Phone (< 1024 px)                  Desktop (≥ 1024 px, `useIsDesktop()`)
┌────────────────────┐             ┌──────────────────────────────────────────────┐
│ TopBar             │             │ TopBar                                       │
│ Preview + Transport│             ├──────────┬──────────────────────┬────────────┤
│  (flex-1)          │             │ Media    │ Preview + Transport  │ Inspector  │
├────────────────────┤             │ library  │                      │ slot       │
│ Timeline slot      │ 30dvh       │ 320 px   │                      │ 340 px     │
├────────────────────┤             ├──────────┴──────────────────────┴────────────┤
│ ToolPanels mobile  │             │ ToolPanels desktop (strip)                   │
└────────────────────┘             │ Timeline slot                         260 px │
 + media Sheet (activePanel=media) └──────────────────────────────────────────────┘
```

Sizes live in `layout.ts`. Slot containers are `data-slot="timeline|tools|inspector"`.

### Slot contracts

- **All slots** mount only after the project is loaded (`useProject()` is non-null) and
  unmount when the editor closes. Read/write state through `@/state` only; run edits with
  `dispatch` (see `../state/README.md`). Never fetch or save the project yourself.
- **`Timeline`** fills its container (`h-full`), scrolls internally, and must stay smooth
  with hundreds of clips (virtualise; isolate playhead-driven renders). It owns `zoom`,
  `scroll`, scrubbing (`setPlayhead(t)` — `'user'` source), selection on tap, drag/trim via
  transactions, and drops of library assets (`ASSET_DRAG_MIME` from
  `media/MediaLibrary.tsx`, value = asset id → `addAssetToTimeline(editorStore, asset, {
trackId, at })`). Its container on phones is 30 dvh tall.
- **`ToolPanels({ variant })`**: `'mobile'` renders the bottom tool bar (≥ 44 px targets)
  and its own panels as non-modal bottom `Sheet`s keyed by `activePanel`; the shell already
  renders the media sheet for `activePanel === MEDIA_PANEL`, so a "Media" tool just calls
  `setActivePanel(MEDIA_PANEL)`. `'desktop'` renders a compact strip above the timeline;
  desktop panels appear in the inspector column.
- **`Inspector`** fills the right column on desktop (scrolls itself). It shows properties of
  `useSelectedClip()` / the active panel.

## Shared building blocks

- `actions.ts` — commands returning `CommandResult` (`{ ok } | { ok: false, reason }`):
  `addAssetToTimeline`, `splitAtPlayhead`, `deleteSelection(ripple?)`,
  `duplicateSelection`, `stepFrames`, `seekBy`, plus `isAssetPlaceable`, `mainInsertIndex`.
  Show `reason` with `toast(reason)`.
- `shortcuts.ts` — `useEditorShortcuts()` is installed by the shell. Add bindings with
  `registerShortcut({ keys, mod?, shift?, label, run })` (returns an unregister function;
  registered bindings win over defaults). Shortcuts never fire while typing in fields or
  with a modal open.
- `session.ts` — `flushProject()` (await before jobs that read the project),
  `hasPendingChanges()`.
- `viewer/` — `PreviewArea` (preview + transport + fullscreen), `PreviewCanvas` (sizes a
  9:16 canvas at DPR ≤ 2, creates the engine from `@/preview`, binds it to the store; shows a
  fallback and runs a plain clock if the engine can't start), `Transport`.
- `media/MediaLibrary.tsx` — assets grid with upload/proxy status; tap or drag to add.
- `export/ExportDialog.tsx` — export settings, size estimate, live progress, result.
- Design system: `@/components/*` (Button, IconButton, Sheet, Dialog/AdaptiveModal, Tabs,
  SegmentedControl, Slider with `onChangeStart/onChangeEnd` for transactions, ColorPicker,
  Toast, Tooltip, ProgressRing, Skeleton, EmptyState, Spinner, FileButton).

### Slider/ColorPicker → one undo step

```tsx
<Slider
  label="Volume"
  min={0}
  max={2}
  step={0.01}
  defaultValue={1}
  value={clip.audio.volume}
  onChangeStart={() => s().beginTransaction('Volume')}
  onChange={(v) => s().dispatch('Volume', (d) => setVolume(d, clip.id, v))}
  onChangeEnd={() => s().commitTransaction()}
/>
```

## On-canvas editing (`viewer/overlay/`)

`TransformOverlay` sits over the preview (outside its clipping box so handles stay
grabbable at the edges); `OverlayController` does all per-frame work imperatively, like the
timeline's view.

| Input                                 | Result                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------- |
| tap a clip / empty canvas             | select the top-most visual clip (text above media) / deselect             |
| drag                                  | move; snaps to centre, edges and safe-zone lines (haptic tick); Alt off   |
| corner handle · rotate handle         | scale about the centre (100 % snap) · rotate (90° snap, Shift = 15°)      |
| two fingers                           | move + pinch-scale + twist together                                       |
| double-tap text                       | inline editor (Ctrl/⌘+Enter or click away commits, Esc cancels)           |
| Crop (toolbar) · Safe zones (toolbar) | drag the crop window over the whole source · Reels/TikTok/Shorts UI zones |

A gesture previews through `viewer/previewOverride.ts` (the engine gets a patched project;
the store and React are untouched — no re-render per pointer move) and commits ONE dispatch
on release. Keyframe-aware: animated properties get a keyframe written/updated at the
playhead (`panels/model/keyframes.ts` semantics), constant ones change their value.
Geometry (`overlay/geometry.ts`) reuses the compositor's `computeLayer` through the preview's
additive geometry API, so the frame matches the drawn pixels.

## Timeline edit modes

- **Slip**: Alt+drag a video/audio clip (touch: keep holding after the lift haptic until a
  second haptic, then drag). A ghost filmstrip shows the whole available source.
- **Roll**: Alt+drag a main-track cut, or turn on the Roll toggle (timeline tool bar).
- **Ripple trim**: Ripple toggle — trimming a free-track clip shifts the later clips on its
  track (the main track always ripples).
- **Box select**: mouse drag on empty lanes (Shift adds); two-finger drag on touch (a pinch
  is recognised when the finger distance changes first).
- **Groups** move across tracks by whole rows and snap on any member's edges.
- **Copy / cut / paste** (`clipboard.ts`): across tracks, pasted at the playhead, persisted
  per device so clips can go to another project.

Modes are device preferences in `editPrefs.ts` (not project data).

## Keyboard shortcuts (defaults)

Space play/pause · J back 1 s · K pause · L play · ←/→ frame (Shift = 1 s) · S split ·
Delete/Backspace delete (Shift = ripple) · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl+Y redo ·
Ctrl/Cmd+D duplicate · Ctrl/Cmd+C / X / V copy, cut, paste · +/− zoom · Home/End · Esc clear
selection (or cancel the running gesture).
