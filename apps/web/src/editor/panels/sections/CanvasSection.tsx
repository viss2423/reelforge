/** Canvas: background colour, blurred fill behind letterboxed media, frame rate. */
import { ColorPicker } from '@/components/ColorPicker.tsx'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { useEditor } from '@/state/selectors.ts'
import { edit, gesture } from '../model/commands.ts'
import { setCanvas } from '../model/edits.ts'
import { Section, Toggle } from '../ui.tsx'

const FPS = [24, 25, 30, 50, 60] as const
const FPS_OPTIONS = FPS.map((v) => ({ value: v, label: String(v) }))

export function CanvasSection() {
  const settings = useEditor((s) => s.project?.settings)
  if (!settings) return null
  return (
    <>
      <Section title="Background">
        <Toggle
          label="Blur fill"
          description="Fill the bars around non-vertical media with a blurred copy"
          checked={settings.backgroundBlur}
          onChange={(on) => edit('Blur fill', (d) => setCanvas(d, { backgroundBlur: on }))}
        />
        <ColorPicker
          label="Background colour"
          value={settings.background}
          {...gesture<string>('Background colour', (d, background) => setCanvas(d, { background }))}
        />
      </Section>
      <Section title="Frame rate">
        <SegmentedControl
          label="Frames per second"
          options={FPS_OPTIONS}
          value={settings.fps}
          onChange={(fps) => edit('Frame rate', (d) => setCanvas(d, { fps }))}
        />
      </Section>
    </>
  )
}
