import type { Filters } from './types'

/** Everything a person can narrow the Library by (the sort order is not one). */
export const FILTER_KEYS = ['text', 'minRating', 'flag', 'label', 'edited', 'copies', 'folderId', 'collectionId', 'keywordId', 'camera', 'lens', 'minIso', 'maxIso', 'minFocal', 'maxFocal', 'minAperture', 'maxAperture', 'dateFrom', 'dateTo'] as const satisfies readonly (keyof Filters)[]

/** Is any filter on? Used to tell "nothing matches" from "the library is empty". */
export const hasFilter = (f: Filters) => FILTER_KEYS.some((k) => !!f[k])
