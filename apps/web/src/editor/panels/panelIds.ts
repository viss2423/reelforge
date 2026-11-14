/**
 * `activePanel` ids owned by the tool panels. Root panels work without a selection; clip
 * panels edit the single selected clip and close when the selection no longer fits.
 */
export const ROOT_PANEL = {
  audio: 'audio',
  text: 'text',
  captions: 'captions',
  stickers: 'stickers',
  effects: 'effects',
  filters: 'filters',
  templates: 'templates',
  ai: 'ai',
  canvas: 'canvas',
} as const

export const CLIP_PANEL = {
  speed: 'clip.speed',
  volume: 'clip.volume',
  fade: 'clip.fade',
  animations: 'clip.animations',
  text: 'clip.text',
  adjust: 'clip.adjust',
  filter: 'clip.filter',
  effects: 'clip.effects',
  transform: 'clip.transform',
  chroma: 'clip.chroma',
  replace: 'clip.replace',
  transition: 'clip.transition',
} as const

export type RootPanelId = (typeof ROOT_PANEL)[keyof typeof ROOT_PANEL]
export type ClipPanelId = (typeof CLIP_PANEL)[keyof typeof CLIP_PANEL]
export type PanelId = RootPanelId | ClipPanelId

const CLIP_IDS = new Set<string>(Object.values(CLIP_PANEL))
const ROOT_IDS = new Set<string>(Object.values(ROOT_PANEL))

export const isClipPanel = (id: string | null): id is ClipPanelId => id !== null && CLIP_IDS.has(id)
export const isRootPanel = (id: string | null): id is RootPanelId => id !== null && ROOT_IDS.has(id)
