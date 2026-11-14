/**
 * Global test setup: in-memory IndexedDB, DOM cleanup between tests and a few browser APIs
 * happy-dom does not implement.
 */
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

// Pointer capture is used by Slider/Sheet drags.
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => undefined
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.hasPointerCapture = () => false
}
