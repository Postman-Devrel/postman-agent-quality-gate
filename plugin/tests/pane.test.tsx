import { expect, test } from 'claude-code/testing'

const PANE = { component: 'Pane', requestId: 'quality-gate', props: { title: 'Quality gate', isFocused: false, bodyColumns: 108, placement: 'dock' } as any } as const

const report = (passed: boolean, score: number, rating: string, finding: string) => ({
  passed,
  score,
  rating,
  blockers: passed ? [] : ['contract-lint failed'],
  steps: [{ step: 'contract-lint', status: passed ? 'pass' : 'fail', score: passed ? 100 : 40 }],
  feedback: [{ step: 'contract-lint', status: passed ? 'warn' : 'fail', finding, fix: 'fix it' }],
})

// This checkout: branch feat/here at HEAD, a local report, a CI report for HEAD (run 201) and one for another branch (run 202).
const FILES: Record<string, string> = {
  'gate-results/report.json': JSON.stringify(report(true, 95, 'A', 'LOCAL-FINDING')),
  'gate-results/ci/201/report.json': JSON.stringify(report(true, 88, 'B', 'HERE-CI-FINDING')),
  'gate-results/ci/202/report.json': JSON.stringify(report(false, 52, 'D', 'OTHER-CI-FINDING')),
}
const RUNS = [
  { databaseId: 201, headBranch: 'feat/here', headSha: 'aaaaaaa1', status: 'completed', conclusion: 'success', createdAt: '2026-10-22T10:00:00Z', url: '' },
  { databaseId: 202, headBranch: 'feat/other', headSha: 'bbbbbbb2', status: 'completed', conclusion: 'failure', createdAt: '2026-10-22T09:00:00Z', url: '' },
  { databaseId: 203, headBranch: 'feat/wip', headSha: 'ccccccc3', status: 'in_progress', conclusion: '', createdAt: '2026-10-22T08:00:00Z', url: '' },
]

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('a Local or CI score in the branches table shows that analysis in the detail', async ($, on) => {
  on('process.run', async (_$, e) => {
    const argv = e.argv.join(' ')
    if (argv.startsWith('git rev-parse --abbrev-ref HEAD HEAD')) return ok('feat/here\naaaaaaa1\n')
    if (argv.startsWith('git rev-parse')) return ok('feat/here\n')
    if (argv.includes('run list') && argv.includes('--branch')) return ok(JSON.stringify([RUNS[0]]))
    if (argv.includes('run list')) return ok(JSON.stringify(RUNS))
    if (argv.includes('pr list')) return ok(JSON.stringify([{ number: 12, headRefName: 'feat/other', title: 'Other' }]))
    return ok('')
  })
  // Paths may reach the engine resolved against the project: match the project-relative tail.
  const file = (path: string) => Object.keys(FILES).find(k => path === k || path.endsWith('/' + k))
  on('fs.exists', async (_$, e) => ({ value: file(e.path) !== undefined }))
  on('fs.read', async (_$, e) => ({ value: FILES[file(e.path) ?? ''] ?? '' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as any)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('clock.now', async () => ({ value: Date.parse('2026-10-22T11:00:00Z') }))

  await $.command.run({ command: 'gate-all', args: '' } as any)
  await $.command.run({ command: 'gate', args: '' } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'postman-agent-quality-gate', surface, ...PANE })

    // A local score only on the checked-out branch, a CI score on every branch that has a report.
    expect(await ui.find({ key: 'local-feat/here' })).toBeDefined()
    expect(await ui.find({ key: 'local-feat/other' })).toBeUndefined()
    expect(await ui.find({ key: 'ci-feat/here' })).toBeDefined()
    expect(await ui.find({ key: 'ci-feat/other' })).toBeDefined()
    // No report yet: the CI column shows the run's state instead of a score.
    expect(await ui.find({ key: 'ci-feat/wip' })).toBeUndefined()
    expect(await ui.find({ text: /in progress/ })).toBeDefined()

    await ui.press({ key: 'ci-feat/other' })
    expect(await ui.find({ text: /OTHER-CI-FINDING/ })).toBeDefined()
    expect(await ui.find({ text: /LOCAL-FINDING/ })).toBeUndefined()

    await ui.press({ key: 'local-feat/here' })
    expect(await ui.find({ text: /LOCAL-FINDING/ })).toBeDefined()
    expect(await ui.find({ text: /OTHER-CI-FINDING/ })).toBeUndefined()

    await ui.press({ key: 'ci-feat/here' })
    expect(await ui.find({ text: /HERE-CI-FINDING/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an unknown schema_version is flagged and a custom workflow and results dir are used', { options: { workflow: 'my-gate', resultsDir: 'out' } }, async ($, on) => {
  const seen: string[] = []
  on('process.run', async (_$, e) => {
    const argv = e.argv.join(' ')
    seen.push(argv)
    if (argv.startsWith('git rev-parse --abbrev-ref HEAD HEAD')) return ok('feat/here\naaaaaaa1\n')
    if (argv.startsWith('git rev-parse')) return ok('feat/here\n')
    if (argv.includes('run list')) return ok('[]')
    return ok('')
  })
  const files: Record<string, string> = { 'out/report.json': JSON.stringify({ ...report(true, 91, 'A', 'FUTURE-FINDING'), schema_version: 9 }) }
  const file = (path: string) => Object.keys(files).find(k => path === k || path.endsWith('/' + k))
  on('fs.exists', async (_$, e) => ({ value: file(e.path) !== undefined }))
  on('fs.read', async (_$, e) => ({ value: files[file(e.path) ?? ''] ?? '' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as any)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('clock.now', async () => ({ value: Date.parse('2026-10-22T11:00:00Z') }))

  await $.command.run({ command: 'gate', args: '' } as any)
  expect(seen.some(a => a.includes('--workflow my-gate'))).toBe(true)

  const ui = await $.ui.mount({ plugin: 'postman-agent-quality-gate', surface: 'terminal', ...PANE })
  expect(await ui.find({ text: /schema version not known/ })).toBeDefined()
  await ui.unmount()
})
