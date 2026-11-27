/** Text tool: add plain text or a trending preset at the playhead, then edit it in place. */
import { Type } from 'lucide-react'
import { Button } from '@/components/Button.tsx'
import { editorStore } from '@/state/editorStore.ts'
import { usePacksData } from '../hooks.ts'
import { catalog } from '../model/catalog.ts'
import { edit } from '../model/commands.ts'
import { addText } from '../model/edits.ts'
import { TextPresetGallery } from '../sections/TextSection.tsx'
import { PanelBody, Section } from '../ui.tsx'
import { CLIP_PANEL } from '../panelIds.ts'

/** Adds text and opens its editor so the user can type straight away. */
const insert = (preset?: Parameters<typeof addText>[2]) => {
  const s = editorStore.getState()
  const clip = edit(preset ? `Add text: ${preset.item.name}` : 'Add text', (d) =>
    addText(d, s.playhead, preset),
  )
  if (!clip) return
  s.select([clip.id])
  s.setActivePanel(CLIP_PANEL.text)
}

export function TextPanel() {
  const packs = usePacksData()
  const hasPresets = catalog(packs, 'textPresets').length > 0
  return (
    <PanelBody>
      <Button
        variant="primary"
        size="lg"
        block
        className="panels-cta"
        icon={<Type size={18} />}
        onClick={() => insert()}
      >
        Add text
      </Button>
      {hasPresets && (
        <Section title="Trending styles">
          <TextPresetGallery onPick={(p) => insert(p)} />
        </Section>
      )}
    </PanelBody>
  )
}
