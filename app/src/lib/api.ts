import { createMockApi } from './mockApi'
import { tauriApi } from './tauriApi'
import type { Api } from './types'

const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

function mockFromUrl(): Api {
  // Test switches, only in a plain browser: ?seed=0 &longnames=1 &fail=1 &nofaces=1 &pick=<path>
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
  const seed = q.get('seed')
  return createMockApi(seed === null ? 96 : Math.max(0, Math.min(5000, Number(seed) || 0)), {
    pick: q.get('pick') ?? undefined,
    longNames: q.get('longnames') === '1',
    failWrites: q.get('fail') === '1',
    noFaces: q.get('nofaces') === '1',
    newerVersion: q.get('newer') ?? undefined,
    donate: q.get('donate') === '1',
    failPreview: q.get('failpreview') === '1',
    mcpFail: q.get('mcpfail') === '1',
    bookFail: q.get('bookfail') === '1',
    corrupt: q.get('corrupt') === '1',
    missing: q.get('missing') === '1',
    card: q.get('card') === '1',
    cardLate: q.get('card') === 'late',
    wideDisplay: q.get('wide') === '1',
    xmpForeign: q.get('xmpforeign') === '1',
    xmpFail: q.get('xmpfail') === '1',
    backupFail: q.get('backupfail') === '1',
    licence: (['licensed', 'trial', 'expired', 'free'] as const).find((v) => v === q.get('licence')),
    // ?catalogs=2 puts two more catalogs on the list: one that holds photos' worth of nothing yet, and one whose folder is gone
    extraCatalogs: q.get('catalogs') === '2' ? [{ id: 'old', name: 'Old shoots', path: 'memory://old' }, { id: 'lost', name: 'Lost drive', path: 'memory://gone/Lost drive' }] : undefined,
  })
}

let current: Api = inTauri ? tauriApi : mockFromUrl()

export const api = (): Api => current
/** Tests swap in a fresh mock. */
export const setApi = (a: Api) => {
  current = a
}
