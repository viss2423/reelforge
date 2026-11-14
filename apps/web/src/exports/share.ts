/**
 * Getting a finished export off the host and onto the device.
 *
 * - Download: a plain link with `?download=1` (server sets Content-Disposition), streamed by
 *   the browser's download manager — no memory cost, works for any size.
 * - Save to device (desktop Chromium): File System Access picker + streaming `pipeTo`, so a
 *   2 GB 4K export never sits in memory.
 * - Share (phones): Web Share Level 2 needs an in-memory `File`; that's the only way into
 *   Instagram/TikTok's share targets and iOS "Save Video". Exports are short reels, so the
 *   blob is a few tens of MB.
 */
import { api } from '@/api/index.ts'

export const exportFileName = (projectName: string | undefined, jobId: string): string => {
  const base = (projectName ?? 'reel')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return `${base || 'reel'}-${jobId.slice(-6)}.mp4`
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (opts: {
    suggestedName: string
    types: { description: string; accept: Record<string, string[]> }[]
  }) => Promise<FileSystemFileHandle>
}

/** True when files can be shared to other apps (Android Chrome, iOS Safari). */
export const canShareFiles = (): boolean => {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') return false
  try {
    return navigator.canShare({ files: [new File([], 'x.mp4', { type: 'video/mp4' })] })
  } catch {
    return false
  }
}

export const canStreamSave = (): boolean =>
  typeof window !== 'undefined' &&
  typeof (window as SaveFilePickerWindow).showSaveFilePicker === 'function'

/** Opens the native share sheet with the exported video. Resolves false if the user cancelled. */
export const shareExport = async (jobId: string, fileName: string): Promise<boolean> => {
  const res = await fetch(api.exportFileUrl(jobId), {
    credentials: 'include',
    headers: api.authHeaders(),
  })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const file = new File([await res.blob()], fileName, { type: 'video/mp4' })
  try {
    await navigator.share({ files: [file], title: fileName })
    return true
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return false
    throw err
  }
}

/** Streams the export into a user-chosen file (desktop). Resolves false if cancelled. */
export const saveExportToDisk = async (jobId: string, fileName: string): Promise<boolean> => {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker
  if (!picker) throw new Error('Saving files is not supported in this browser')
  let handle: FileSystemFileHandle
  try {
    handle = await picker({
      suggestedName: fileName,
      types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return false
    throw err
  }
  const res = await fetch(api.exportFileUrl(jobId), {
    credentials: 'include',
    headers: api.authHeaders(),
  })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
  await res.body.pipeTo(await handle.createWritable())
  return true
}
