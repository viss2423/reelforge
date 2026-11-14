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

## Keyboard shortcuts (defaults)

Space play/pause · J back 1 s · K pause · L play · ←/→ frame (Shift = 1 s) · S split ·
Delete/Backspace delete (Shift = ripple) · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl+Y redo ·
Ctrl/Cmd+D duplicate · +/− zoom · Home/End · Esc clear selection.
