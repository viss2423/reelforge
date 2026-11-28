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

// No real network in unit tests. Without a stub, a request would go to happy-dom's origin
// (localhost:3000) and the outcome would depend on whatever happens to listen there. Fail
// it at once, the way an unreachable host does. Tests that need answers stub `fetch`
// (stubbed globals are restored to this guard between tests).
globalThis.fetch = (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input)
  return Promise.reject(new TypeError(`network is disabled in unit tests (fetch ${url})`))
}
