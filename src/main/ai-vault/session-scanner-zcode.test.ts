import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleOpenCodeSqliteRequest } from './session-scanner-opencode-sqlite-dispatch'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import { writeOpenCodeSqliteDatabase } from './session-scanner-opencode-sqlite-fixture'
import SyncDatabase from '../sqlite/sync-database'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true })
  }
  directories.length = 0
})

describe('ZCode AI Vault SQLite worker', () => {
  it('lists, parses, and captures ZCode sessions without labelling them OpenCode', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-zcode-ai-vault-'))
    directories.push(directory)
    const dbPath = join(directory, 'db.sqlite')
    writeOpenCodeSqliteDatabase(dbPath, [
      {
        id: 'zcode-session',
        directory: '/repo',
        title: 'ZCode task',
        turns: [
          { role: 'user', parts: ['Fix the import'] },
          { role: 'assistant', parts: ['Import fixed'] }
        ]
      }
    ])

    const listed = await handleOpenCodeSqliteRequest({
      id: 1,
      kind: 'list',
      agent: 'zcode',
      dbPaths: [dbPath],
      limit: 10
    })
    expect(listed.ok).toBe(true)
    if (!listed.ok) {
      return
    }
    const candidates = (listed.value as { candidates: { agent: string; file: { path: string } }[] })
      .candidates
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.agent).toBe('zcode')
    expect(splitOpenCodeSqliteCandidate(candidates[0]!.file.path, 'zcode')).toEqual({
      dbPath,
      sessionId: 'zcode-session'
    })
    expect(splitOpenCodeSqliteCandidate(candidates[0]!.file.path)).toBeNull()

    const parsed = await handleOpenCodeSqliteRequest({
      id: 2,
      kind: 'parse',
      agent: 'zcode',
      dbPath,
      sessionId: 'zcode-session',
      platform: 'darwin'
    })
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        agent: 'zcode',
        title: 'ZCode task',
        resumeCommand: "cd '/repo' && zcode --resume 'zcode-session'"
      }
    })

    const captured = await handleOpenCodeSqliteRequest({
      id: 3,
      kind: 'capture',
      agent: 'zcode',
      dbPath,
      sessionId: 'zcode-session',
      platform: 'darwin'
    })
    expect(captured).toMatchObject({ ok: true, value: { session: { agent: 'zcode' } } })
    if (!captured.ok) {
      return
    }
    expect((captured.value as { messages: { text: string }[] }).messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'Fix the import' })])
    )
  })

  it('excludes ZCode hidden transcript messages from preview and search', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-zcode-ai-vault-'))
    directories.push(directory)
    const dbPath = join(directory, 'db.sqlite')
    writeOpenCodeSqliteDatabase(dbPath, [
      {
        id: 'visible-session',
        turns: [
          { role: 'user', parts: ['internal reminder'] },
          { role: 'user', parts: ['visible request'] },
          { role: 'assistant', parts: ['visible response'] }
        ]
      }
    ])
    const db = new SyncDatabase(dbPath)
    try {
      db.prepare(
        "UPDATE message SET data = json_set(data, '$.semantics.transcriptVisibility', 'hidden') WHERE id LIKE '%-msg-0-%'"
      ).run()
    } finally {
      db.close()
    }

    const parsed = await handleOpenCodeSqliteRequest({
      id: 4,
      kind: 'parse',
      agent: 'zcode',
      dbPath,
      sessionId: 'visible-session',
      platform: 'darwin',
      fullFirstUserPrompt: true
    })
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        messageCount: 2,
        firstUserPrompt: 'visible request'
      }
    })
    if (!parsed.ok) {
      return
    }
    expect(JSON.stringify(parsed.value)).not.toContain('internal reminder')

    const captured = await handleOpenCodeSqliteRequest({
      id: 5,
      kind: 'capture',
      agent: 'zcode',
      dbPath,
      sessionId: 'visible-session',
      platform: 'darwin'
    })
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }
    expect(JSON.stringify(captured.value)).not.toContain('internal reminder')
  })
})
