import type { FolderRow } from './types'

/** One line of the folder tree. `folderId` is set when the catalog has a folder there; a line made only to hold others has none. */
export interface FolderNode {
  /** unique and stable: the root and the path from it */
  key: string
  label: string
  folderId?: number
  /** the photos in this folder itself */
  count: number
  /** the photos in this folder and every folder inside it */
  total: number
  /** where it is on the disk, for the tooltip */
  path: string
  /** on a root: where the root is on the disk, to ask how much room is left there */
  rootPath?: string
  children: FolderNode[]
}

/**
 * The folders as a tree: one top line for each folder that was imported from (the root), and under it the folders inside, nested by
 * their path. Lines that hold no photos of their own but have folders inside (a year, a month) are kept so the tree is whole.
 */
export function buildTree(rows: FolderRow[]): FolderNode[] {
  const roots = new Map<string, FolderNode>()
  const rootOf = (name: string): FolderNode => {
    let r = roots.get(name)
    if (!r) roots.set(name, (r = { key: name, label: name, count: 0, total: 0, path: name, rootPath: undefined, children: [] }))
    return r
  }
  for (const row of rows) {
    let node = rootOf(row.root)
    node.rootPath ??= row.rootPath
    const parts = row.relPath.split('/').filter(Boolean)
    for (const part of parts) {
      let next = node.children.find((c) => c.label === part)
      if (!next) {
        next = { key: `${node.key}/${part}`, label: part, count: 0, total: 0, path: `${node.path}/${part}`, children: [] }
        node.children.push(next)
      }
      node = next
    }
    node.folderId = row.id
    node.count = row.count
  }
  const sum = (n: FolderNode): number => {
    n.children.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))
    n.total = n.count + n.children.reduce((t, c) => t + sum(c), 0)
    return n.total
  }
  const out = [...roots.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  out.forEach(sum)
  return out
}

/** The keys of the lines above the folder with this id, so the tree can be opened to show the folder that is chosen. */
export function ancestorsOf(tree: FolderNode[], folderId: number): string[] {
  const walk = (n: FolderNode, above: string[]): string[] | null => {
    if (n.folderId === folderId) return above
    for (const c of n.children) {
      const r = walk(c, [...above, n.key])
      if (r) return r
    }
    return null
  }
  for (const r of tree) {
    const found = walk(r, [])
    if (found) return found
  }
  return []
}
