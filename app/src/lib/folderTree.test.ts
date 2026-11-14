import { describe, expect, it } from 'vitest'
import { ancestorsOf, buildTree } from './folderTree'

const row = (id: number, root: string, relPath: string, count: number) => ({ id, root, rootPath: 'C:/' + root, relPath, count })

describe('the folder tree', () => {
  const rows = [row(1, 'Photos', '', 2), row(2, 'Photos', '2026/10/19', 5), row(3, 'Photos', '2026/10/20', 7), row(4, 'Photos', '2025', 1), row(5, 'Card', 'DCIM/100', 9)]
  const tree = buildTree(rows)

  it('has one top line for each root and nests the folders by their path', () => {
    expect(tree.map((r) => r.label)).toEqual(['Card', 'Photos'])
    const photos = tree[1]
    expect(photos.folderId).toBe(1)
    expect(photos.children.map((c) => c.label)).toEqual(['2025', '2026'])
    const year = photos.children[1]
    expect(year.folderId).toBeUndefined() // a line made only to hold others
    expect(year.children.map((c) => c.label)).toEqual(['10'])
    expect(year.children[0].children.map((c) => [c.label, c.folderId])).toEqual([['19', 2], ['20', 3]])
  })

  it('adds up what is inside, and keeps a folder\'s own count apart', () => {
    const photos = tree[1]
    expect(photos.count).toBe(2)
    expect(photos.total).toBe(2 + 5 + 7 + 1)
    expect(photos.children[1].total).toBe(12)
    expect(tree[0].total).toBe(9)
  })

  it('sorts numbers as numbers and finds the lines above a folder', () => {
    const t = buildTree([row(1, 'R', 'a/10', 1), row(2, 'R', 'a/9', 1), row(3, 'R', 'a/100', 1)])
    expect(t[0].children[0].children.map((c) => c.label)).toEqual(['9', '10', '100'])
    expect(ancestorsOf(tree, 3)).toEqual(['Photos', 'Photos/2026', 'Photos/2026/10'])
    expect(ancestorsOf(tree, 999)).toEqual([])
  })

  it('copes with no folders and with a leading or doubled slash', () => {
    expect(buildTree([])).toEqual([])
    expect(buildTree([row(1, 'R', '/x//y/', 3)])[0].children[0].children[0].folderId).toBe(1)
  })
})
