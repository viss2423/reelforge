import { render, screen } from '@testing-library/react'
import type { Asset } from '@reelforge/core'
import { describe, expect, it, vi } from 'vitest'
import { AssetTile } from '@/editor/media/MediaLibrary.tsx'
import { makeAsset } from '../../fixtures.ts'

const tile = (thumbnails: 'pending' | 'ready' | 'failed') => {
  const asset = makeAsset({ id: 'a1', name: 'clip.mp4', thumbnails })
  const { container } = render(
    <ul>
      <AssetTile asset={asset} used={false} onAdd={vi.fn<(a: Asset) => void>()} />
    </ul>,
  )
  return container.querySelector('img')
}

describe('AssetTile', () => {
  it('requests the poster only once the host has made it', () => {
    expect(tile('pending')).toBeNull()
    expect(tile('failed')).toBeNull()
    expect(tile('ready')?.getAttribute('src')).toMatch(/\/api\/assets\/a1\/poster\.jpg/)
    expect(screen.getAllByRole('button', { name: 'Add clip.mp4 to timeline' })).toHaveLength(3)
  })
})
