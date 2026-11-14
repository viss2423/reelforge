/**
 * App-wide API singletons. Import `api` for HTTP, `events` for realtime, and the hooks in
 * `./queries.ts` for cached server state.
 */
import { auth } from './auth.ts'
import { ApiClient } from './client.ts'
import { EventSocket } from './ws.ts'

export { ApiClient, ApiError, RevisionConflict } from './client.ts'
export type { CreateProjectInput, JobFilter } from './client.ts'
export { auth, describeDevice } from './auth.ts'
export { EventSocket, type SocketState } from './ws.ts'
export type { Device, Packs, ProjectSummary, SystemInfo } from './schemas.ts'

export const api = new ApiClient()

/** Shared realtime connection; started by the app shell once the device is paired. */
export const events = new EventSocket({ url: () => api.eventsUrl() })

/** The device id used as `origin` for saves. */
export const deviceId = (): string => auth.deviceId
