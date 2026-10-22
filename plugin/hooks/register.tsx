import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CiRun, GateReport, GateSelection, OverviewRow } from '../types'

const PANE = 'quality-gate'
const RUNNER = 'npx github:Postman-Devrel/postman-agent-quality-gate#v1'
const KNOWN_SCHEMA = 1
// Set from the plugin's options when the module registers.
let WORKFLOW = 'quality-gate'
let RESULTS = 'gate-results'
const OVERVIEW_MS = 60000
const MAX_ROWS = 10
const MAX_DOWNLOADS = 5
const POLL_MS = 20000

const report = atom({ plugin: 'postman-agent-quality-gate', key: 'report' } as const, null)
const local = atom({ plugin: 'postman-agent-quality-gate', key: 'local' } as const, null)
const ciReport = atom({ plugin: 'postman-agent-quality-gate', key: 'ciReport' } as const, null)
const run = atom({ plugin: 'postman-agent-quality-gate', key: 'run' } as const, null)
const branch = atom({ plugin: 'postman-agent-quality-gate', key: 'branch' } as const, '')
const note = atom({ plugin: 'postman-agent-quality-gate', key: 'note' } as const, '')
// The band above the prompt is off by default: the pane is the main view. /gate-band turns it on.
const isHidden = atom({ plugin: 'postman-agent-quality-gate', key: 'isHidden' } as const, true)
const overview = atom({ plugin: 'postman-agent-quality-gate', key: 'overview' } as const, [])
// Pane layout: which analysis the detail shows, and which sections are folded.
const selected = atom({ plugin: 'postman-agent-quality-gate', key: 'selected' } as const, null)
const detail = atom({ plugin: 'postman-agent-quality-gate', key: 'detail' } as const, null)
const fixOpen = atom({ plugin: 'postman-agent-quality-gate', key: 'fixOpen' } as const, true)
const branchesOpen = atom({ plugin: 'postman-agent-quality-gate', key: 'branchesOpen' } as const, true)

/**
 * Postman palette (Aether design system), in hex so it does not depend on the person's theme: the
 * brand orange as accent, Postman's green, yellow, red and blue for the states, mid-tone greys that
 * read on a light and a dark background alike.
 */
const C = { ok: '#0CBB52', warn: '#FFB400', bad: '#EB2013', idle: '#A6A6A6', accent: '#FF6C37', info: '#097BED', track: '#6B6B6B', ink: '#212121', white: '#FFFFFF' } as const
const COLOR = { pass: C.ok, warn: C.warn, fail: C.bad, not_available: C.idle } as const
const SHORT: Record<string, string> = {
  'skills-check': 'skills',
  'contract-lint': 'lint',
  tests: 'tests',
  'ai-readiness': 'ai',
  impact: 'impact',
}

const ratingColor = (r: GateReport) => (r.passed ? C.ok : C.bad)

/** Color and short label of a branch chip in the band: the rating once known, else the run state. */
const chipColor = (o: OverviewRow) =>
  o.status !== 'completed' ? C.warn : o.passed === true ? C.ok : o.passed === false || o.conclusion === 'failure' ? C.bad : C.idle
const chipLabel = (o: OverviewRow) =>
  o.status !== 'completed' ? `${o.status}…` : o.rating !== '' ? `${o.rating}${o.score}${o.passed ? '' : '✘'}` : o.conclusion || '?'

/**
 * Runs the GitHub CLI. A desktop app often starts with a short PATH (no Homebrew), so `gh` is also
 * tried at its usual absolute paths; the first one that starts is remembered.
 */
let GH_BIN = ''
async function ghRun($: any, args: string[], timeoutMs: number) {
  const candidates = GH_BIN ? [GH_BIN] : ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
  let last: unknown = null
  for (const bin of candidates) {
    try {
      const out = await $.process.run([bin, ...args], { timeoutMs })
      GH_BIN = bin
      return out
    } catch (error) {
      last = error
    }
  }
  throw last
}

let lastRunKey = ''

/** Reads a report.json; null when missing or not a gate report. */
async function readReport($: any, path: string, source: GateReport['source'], sha?: string) {
  try {
    if (!(await $.fs.exists(path))) return null
    const file = await $.fs.read(path)
    const json = JSON.parse(typeof file === 'string' ? file : file.text)
    if (typeof json.score !== 'number' || !Array.isArray(json.steps)) return null
    // An unknown schema_version is read as far as the fields we know are there, and flagged.
    const isUnknownSchema = json.schema_version !== undefined && json.schema_version !== KNOWN_SCHEMA
    return {
      isUnknownSchema,
      source,
      passed: !!json.passed,
      score: json.score,
      rating: String(json.rating),
      blockers: json.blockers ?? [],
      feedback: json.feedback ?? [],
      steps: json.steps,
      sha,
    } as GateReport
  } catch {
    return null
  }
}

async function refresh($: any) {
  const git = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD', 'HEAD'], { timeoutMs: 5000 }).catch(() => null)
  if (!git || git.exitCode !== 0) {
    await update($, note, () => 'not a git repository')
    return
  }
  const [name, head] = git.stdout.trim().split('\n')
  await update($, branch, () => name)

  // Local report: written by the gate runner, instant feedback for the coding agent.
  const localReport = await readReport($, `${RESULTS}/report.json`, 'local')
  let shown: GateReport | null = localReport

  // CI: the latest run of the workflow on this branch. Authoritative when it is for HEAD.
  const list = await ghRun($, ['run', 'list', '--workflow', WORKFLOW, '--branch', name, '--limit', '1', '--json', 'databaseId,status,conclusion,headSha,url'], 20000).catch(() => null)
  let ci: CiRun | null = null
  if (list && list.exitCode === 0) {
    try {
      const one = JSON.parse(list.stdout)[0]
      if (one) {
        ci = { id: one.databaseId, status: one.status, conclusion: one.conclusion || '', sha: one.headSha, isHead: one.headSha === head, url: one.url }
      }
    } catch {}
    await update($, note, () => '')
  } else {
    await update($, note, () => 'gh unavailable: showing the local report only')
  }
  await update($, run, () => ci)

  // Download the report of a finished CI run for the current commit.
  let fromCi: GateReport | null = null
  if (ci && ci.isHead && ci.status === 'completed') {
    const dir = `${RESULTS}/ci/${ci.id}`
    const path = `${dir}/report.json`
    if (!(await $.fs.exists(path))) {
      await ghRun($, ['run', 'download', String(ci.id), '-n', 'gate-report', '-D', dir], 60000).catch(() => null)
    }
    const remote = await readReport($, path, 'ci', ci.sha)
    if (remote) shown = remote
    fromCi = remote
  }
  await update($, report, () => shown)
  await update($, local, () => localReport)
  await update($, ciReport, () => fromCi)

  // Status line and toast on a change of the CI run.
  if (shown) $.ui.status(`Gate ${shown.rating} ${shown.score}${shown.passed ? '' : ' ✗'} · /gate`)
  const key = ci ? `${ci.id}:${ci.status}:${ci.conclusion}` : ''
  if (ci && ci.isHead && key !== lastRunKey) {
    if (lastRunKey !== '') {
      if (ci.status !== 'completed') $.ui.toast(`Gate CI: ${ci.status}`)
      else if (shown?.source === 'ci') $.ui.toast(`Gate CI ${shown.passed ? 'passed' : 'FAILED'}: ${shown.rating} (${shown.score}/100)`)
    }
    lastRunKey = key
  }
}


/** The brief the person can hand to the coding agent: what failed and how to fix it. */
function fixesPrompt(r: GateReport, branchName: string): string {
  const head = `The quality gate ${r.passed ? 'passed with warnings' : 'FAILED'} on branch ${branchName}${r.sha ? ' (commit ' + r.sha.slice(0, 7) + ')' : ''}: rating ${r.rating}, ${r.score}/100.`
  const blockers = r.blockers.length ? `Blockers: ${r.blockers.join('; ')}.` : 'No blocker.'
  const fixes = r.feedback
    .slice(0, 12)
    .map((f, i) => `${i + 1}. [${f.step}] ${f.finding}\n   Fix: ${f.fix}`)
    .join('\n')
  return [
    head,
    blockers,
    fixes ? `Fixes, blockers first:\n${fixes}` : `See ${RESULTS}/report.md.`,
    `Hand these fixes to this project's coding agent, word for word. Apply them in order, never edit the gate or its workflow to get a better verdict, check locally with ${RUNNER} run, then push to the same branch.`,
  ].join('\n')
}

/** What to do next once a CI run for HEAD is known. */
function nextPrompt(r: GateReport, branchName: string): string {
  return r.passed && r.feedback.length === 0
    ? `The quality gate passed on ${branchName} (rating ${r.rating}, ${r.score}/100). Summarize what changed on this branch and open a pull request if there is none.`
    : fixesPrompt(r, branchName)
}

/** True when the report file is the marker of a run the gate skipped (no relevant file changed). */
async function isSkipped($: any, path: string) {
  try {
    if (!(await $.fs.exists(path))) return false
    const file = await $.fs.read(path)
    return JSON.parse(typeof file === 'string' ? file : file.text).skipped === true
  } catch {
    return false
  }
}

/**
 * One row per recent branch: the latest non-cancelled run of the workflow, its rating (from the
 * gate-report artifact, downloaded once and cached under <results dir>/ci/) and its open PR.
 */
async function refreshOverview($: any) {
  const current = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 }).catch(() => null)
  const here = current && current.exitCode === 0 ? current.stdout.trim() : ''
  const runs = await ghRun($, ['run', 'list', '--workflow', WORKFLOW, '--limit', '60', '--json', 'databaseId,headBranch,headSha,status,conclusion,createdAt'], 30000)
    .catch(() => null)
  if (!runs || runs.exitCode !== 0) {
    await update($, note, () => `branches: gh failed (${runs ? String(runs.stderr).trim().slice(0, 80) || 'exit ' + runs.exitCode : 'not found'})`)
    return
  }
  const prs = await ghRun($, ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,title'], 30000)
    .catch(() => null)
  const prByBranch: Record<string, { number: number; title: string }> = {}
  try {
    for (const p of JSON.parse(prs?.stdout || '[]')) prByBranch[p.headRefName] = { number: p.number, title: p.title }
  } catch {}

  // Latest non-cancelled run per branch (a cancelled run was replaced by a newer one).
  const latest: Record<string, any> = {}
  try {
    for (const r of JSON.parse(runs.stdout)) {
      if (r.conclusion === 'cancelled') continue
      const seen = latest[r.headBranch]
      if (!seen || r.createdAt > seen.createdAt) latest[r.headBranch] = r
    }
  } catch {
    return
  }
  const ordered = Object.values(latest)
    .sort((a: any, b: any) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, MAX_ROWS)

  let downloads = 0
  const rows: OverviewRow[] = []
  for (const r of ordered as any[]) {
    const dir = `${RESULTS}/ci/${r.databaseId}`
    const path = `${dir}/report.json`
    if (r.status === 'completed' && !(await $.fs.exists(path)) && downloads < MAX_DOWNLOADS) {
      downloads += 1
      await ghRun($, ['run', 'download', String(r.databaseId), '-n', 'gate-report', '-D', dir], 60000).catch(() => null)
    }
    const rep = r.status === 'completed' ? await readReport($, path, 'ci', r.headSha) : null
    const skipped = r.status === 'completed' && !rep && (await isSkipped($, path))
    const pr = prByBranch[r.headBranch]
    rows.push({
      branch: r.headBranch,
      pr: pr ? pr.number : null,
      title: pr ? pr.title : '',
      status: r.status,
      conclusion: skipped ? 'skipped' : r.conclusion || '',
      rating: rep ? rep.rating : '',
      score: rep ? rep.score : null,
      passed: rep ? rep.passed : null,
      blockers: rep ? rep.blockers.length : 0,
      sha: String(r.headSha).slice(0, 7),
      runId: r.databaseId,
      updatedAt: String(r.createdAt),
      isCurrent: r.headBranch === here,
    })
  }
  await update($, overview, () => rows)
  await update($, note, () => '')
}

/** A score bar: filled and empty parts are runs of spaces on a background, so widths hold in any font. */
function scoreBar(Text: any, score: number | null, color: string, width = 16) {
  const n = score === null ? 0 : Math.max(0, Math.min(width, Math.round((score / 100) * width)))
  return (
    <Text>
      <Text backgroundColor={color}>{' '.repeat(n)}</Text>
      <Text backgroundColor={C.track}>{' '.repeat(width - n)}</Text>
    </Text>
  )
}

/** A fixed-width cell: columns line up whatever the font (no padding with spaces). */
function cell(Box: any, width: number, children: any) {
  return (
    <Box width={width} flexShrink={0}>
      {children}
    </Box>
  )
}

/** "3m", "2h", "5d" since an ISO time. */
const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}

const STATUS_LABEL = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', not_available: 'N/A' } as const

/** A colored pill: white text on a solid background, dark ink on the yellow, as Postman draws it. */
function pill(Text: any, label: string, color: string) {
  return (
    <Text backgroundColor={color} color={color === C.warn ? C.ink : C.white} bold>
      {' ' + label + ' '}
    </Text>
  )
}

/** A rounded card with a colored border. */
function card(Box: any, color: string, children: any, width?: number) {
  return (
    <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column" width={width} marginBottom={1}>
      {children}
    </Box>
  )
}

/** Header of a collapsible section: a button with the fold marker, the title and a hint. */
function foldHeader(Box: any, Text: any, Button: any, key: string, open: boolean, label: string, hint: string, color: string, toggle: () => void) {
  return (
    <Box>
      <Button key={key} label={`${open ? '▾' : '▸'} ${label}`} onPress={toggle} />
      {hint ? <Text color={color}>  {hint}</Text> : null}
    </Box>
  )
}

/** Whether a selection names this analysis (branch and source). */
const isPicked = (sel: GateSelection, branchName: string, source: GateSelection['source']) => sel.branch === branchName && sel.source === source

/**
 * A clickable score in the table: the pill of a rating, a marker before it when its detail is shown.
 * Buttons take Text children, so the pill keeps its colors and the whole cell is one press.
 */
function scoreButton(Text: any, Button: any, key: string, label: string, color: string, picked: boolean, onPress: () => unknown) {
  return (
    <Button key={key} label={`${label}${picked ? ', shown' : ''}`} onPress={onPress}>
      <Text color={C.accent} bold>{picked ? '▸' : ' '}</Text>
      {pill(Text, label, color)}
    </Button>
  )
}

/**
 * Branches: one row each in fixed columns. CI is the latest run of the branch (its score once there is
 * a report, else its state: queued, in progress, failed, skipped), Local the report of
 * the runner in this checkout (the checked-out branch only). A score is a button: it shows
 * the steps and the findings of that analysis below the table.
 */
function branchesSection(rows: OverviewRow[], lo: GateReport | null, here: string, sel: GateSelection, now: number, open: boolean, Box: any, Text: any, Button: any, $: any) {
  const bad = rows.filter(r => r.passed === false || r.conclusion === 'failure').length
  const good = rows.filter(r => r.passed === true).length
  // The checked-out branch has a row even before its first CI run, so its local score is reachable.
  const all = here !== '' && !rows.some(r => r.isCurrent) ? [{ branch: here, pr: null, title: '', status: '', conclusion: '', rating: '', score: null, passed: null, blockers: 0, sha: '', runId: 0, updatedAt: '', isCurrent: true } as OverviewRow, ...rows] : rows
  const pickCi = (row: OverviewRow) => async () => {
    const rep = await readReport($, `${RESULTS}/ci/${row.runId}/report.json`, 'ci', row.sha)
    if (!rep) {
      $.ui.toast(`No gate report downloaded yet for run ${row.runId}.`)
      return
    }
    await update($, detail, () => rep)
    await update($, selected, () => ({ branch: row.branch, source: 'ci' as const, runId: row.runId }))
  }
  const pickLocal = (branchName: string) => () => update($, selected, () => ({ branch: branchName, source: 'local' as const, runId: null }))
  return (
    <Box flexDirection="column">
      {foldHeader(Box, Text, Button, 'fold-branches', open, 'BRANCHES', `${rows.length} · ${good} passing · ${bad} failing · click a score for its detail`, bad > 0 ? C.bad : C.ok, () => update($, branchesOpen, () => !open))}
      {open && (
        <Box borderStyle="round" borderColor={C.accent} paddingX={1} flexDirection="column" marginBottom={1}>
          {all.length === 0 && <Text dimColor>No gate run found yet. This needs an authenticated gh in the project.</Text>}
          {all.length > 0 && (
            <Box>
              {cell(Box, 2, <Text> </Text>)}
              {cell(Box, 26, <Text color={C.info} bold>branch</Text>)}
              {cell(Box, 14, <Text color={C.info} bold>CI</Text>)}
              {cell(Box, 10, <Text color={C.info} bold>Local</Text>)}
              {cell(Box, 6, <Text color={C.info} bold>PR</Text>)}
              {cell(Box, 11, <Text color={C.info} bold>blockers</Text>)}
              {cell(Box, 5, <Text color={C.info} bold>age</Text>)}
            </Box>
          )}
          {all.map(row => {
            const color = chipColor(row)
            const state = row.status === '' ? 'no run' : row.status !== 'completed' ? row.status.replace('_', ' ') : row.passed === null ? row.conclusion || '?' : row.passed ? 'passed' : 'failed'
            const localHere = row.isCurrent ? lo : null
            return (
              <Box>
                {cell(Box, 2, <Text color={C.accent}>{row.isCurrent ? '▶' : ' '}</Text>)}
                {cell(Box, 26, <Text bold={row.isCurrent} color={row.isCurrent ? C.accent : undefined} wrap="truncate-end">{row.branch}</Text>)}
                {cell(
                  Box,
                  14,
                  row.rating !== ''
                    ? scoreButton(Text, Button, `ci-${row.branch}`, `${row.rating} ${row.score}`, color, isPicked(sel, row.branch, 'ci'), pickCi(row))
                    : <Text color={row.status === '' ? C.idle : color}>  {state}</Text>,
                )}
                {cell(
                  Box,
                  10,
                  localHere
                    ? scoreButton(Text, Button, `local-${row.branch}`, `${localHere.rating} ${localHere.score}`, ratingColor(localHere), isPicked(sel, row.branch, 'local'), pickLocal(row.branch))
                    : <Text color={C.idle}>  –</Text>,
                )}
                {cell(Box, 6, <Text color={C.info}>{row.pr !== null ? `#${row.pr}` : ''}</Text>)}
                {cell(Box, 11, <Text color={C.bad}>{row.blockers > 0 ? `${row.blockers} blocker${row.blockers > 1 ? 's' : ''}` : ''}</Text>)}
                {cell(Box, 5, <Text dimColor>{row.updatedAt ? ago(row.updatedAt, now) : ''}</Text>)}
                {row.runId !== 0 && (
                  <Button
                    key={`ask-${row.branch}`}
                    label="→"
                    dimColor
                    onPress={() =>
                      $.prompt.fill({
                        text: `Show me the quality gate result of branch ${row.branch}${row.pr !== null ? ` (PR #${row.pr})` : ''} (run ${row.runId}) and, if it failed, hand the fixes to this project's coding agent on that branch.`,
                      })
                    }
                  />
                )}
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  WORKFLOW = String(options?.workflow || 'quality-gate')
  RESULTS = String(options?.resultsDir || 'gate-results').replace(/\/+$/, '')
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gate', description: 'Show the quality gate report (local and CI) in a pane' })
    await $.command.register({ name: 'gate-all', description: 'Same pane as /gate: the gate state of every recent branch and open PR' })
    await $.command.register({ name: 'gate-band', description: 'Show or hide the compact gate band above the prompt' })
    void $.ui.open({ id: PANE, title: 'Quality gate', columns: 110, rows: 26 })
    void refresh($)
    void refreshOverview($)
    $.clock.every(POLL_MS, () => void refresh($))
    $.clock.every(OVERVIEW_MS, () => void refreshOverview($))
    return next(e)
  })

  on('command.run', { command: 'gate' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Quality gate', columns: 110, rows: 26 })
    return { text: 'Quality gate pane opened.' }
  })

  on('command.run', { command: 'gate-band' }, async $ => {
    const hidden = await read($, isHidden)
    await update($, isHidden, () => !hidden)
    return { text: hidden ? 'Gate band shown above the prompt.' : 'Gate band hidden.' }
  })

  on('command.run', { command: 'gate-all' }, async $ => {
    await refreshOverview($)
    await $.ui.open({ id: PANE, title: 'Quality gate', columns: 110, rows: 26 })
    return { text: 'Quality gate pane opened.' }
  })

  // A tool call that may have changed the gate result: refresh soon after a local gate run or a push.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (/postman-agent-quality-gate|git push|gh pr create/.test(String((e as any).command ?? ''))) {
      void refresh($)
      void $.ui.open({ id: PANE, title: 'Quality gate', columns: 110, rows: 26 })
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, report)
    const rows = await read($, overview)
    const curName = await read($, branch)
    const problem = await read($, note)
    // Nothing to show only when there is neither a report, nor another branch, nor a problem to report.
    if (e.props.hasSurvey || (!r && rows.length === 0 && problem === '') || (await read($, isHidden))) return next(e)
    const ci = await read($, run)
    const prs = rows.filter(x => x.pr !== null)
    const others = rows.filter(x => !x.isCurrent).slice(0, 4)
    const prOk = prs.filter(x => x.passed === true).length
    const prKo = prs.filter(x => x.passed === false || x.conclusion === 'failure').length
    const { Box, Text, Button } = $.ui.resolve(e)
    const sha = !r ? '' : r.source === 'ci' ? ` ci@${(r.sha ?? '').slice(0, 7)}` : ' local'
    const pending = ci && ci.isHead && ci.status !== 'completed' ? ` · CI ${ci.status}…` : ''
    const lo = await read($, local)
    const ciRep = await read($, ciReport)
    const ciRun = await read($, run)
    const chip = (g: GateReport | null) => (g ? `${g.passed ? '✔' : '✘'} ${g.rating} ${g.score}` : '–')
    const ciState = ciRep ? chip(ciRep) : ciRun && ciRun.isHead && ciRun.status !== 'completed' ? `${ciRun.status.replace('_', ' ')}…` : '–'
    const differs = lo && ciRep && (lo.score !== ciRep.score || lo.passed !== ciRep.passed)
    return (
      <Box>
        <Text backgroundColor={C.accent} color={C.white} bold>{' ◉ '}</Text>
        <Text bold color={C.accent}> Gate  </Text>
        <Text dimColor>local </Text>
        <Text bold color={lo ? ratingColor(lo) : C.idle}>{chip(lo)}</Text>
        <Text dimColor>   CI </Text>
        <Text bold color={ciRep ? ratingColor(ciRep) : C.idle}>{ciState}</Text>
        {differs && <Text color={C.warn}> ⚠ local and CI differ</Text>}
        <Text dimColor>{prs.length > 0 ? `  PRs ${prOk}✔ ${prKo}✘` : ''}{others.length > 0 ? `  ${others.length} other branch${others.length > 1 ? 'es' : ''}` : ''}  </Text>
        <Button key="rerun" label="↻" onPress={() => $.prompt.submit({ text: `Run ${RUNNER} run and summarize the gate result.` })} />
        <Button
          key="fix"
          label="🔧"
          variant="primary"
          onPress={() => {
            if (!r || r.feedback.length === 0) {
              $.ui.toast(r ? 'The gate has nothing to fix.' : 'No gate report yet: re-run the gate first.')
              return
            }
            return $.prompt.submit({ text: fixesPrompt(r, curName) })
          }}
        />
        <Button key="open" label="⧉" onPress={() => $.ui.open({ id: PANE, title: 'Quality gate', columns: 110, rows: 26 })} />
        <Button key="hide" label="✕" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const auto = await read($, report)
    const lo = await read($, local)
    const ciRep = await read($, ciReport)
    const ci = await read($, run)
    const name = await read($, branch)
    const hint = await read($, note)
    const rowsAll = await read($, overview)
    const picked = await read($, selected)
    const other = await read($, detail)
    const fixIsOpen = await read($, fixOpen)
    const branchesIsOpen = await read($, branchesOpen)
    const now = await $.clock.now()

    // What the detail shows: the picked analysis; by default the checked-out branch, CI for HEAD else local.
    const sel: GateSelection = picked ?? { branch: name, source: auto?.source ?? 'local', runId: null }
    const r =
      sel.source === 'local'
        ? sel.branch === name ? lo : null
        : sel.branch === name && sel.runId === null ? ciRep ?? auto : other
    const runLine = ci
      ? `CI run ${ci.id} · ${ci.status}${ci.conclusion ? '/' + ci.conclusion : ''}${ci.isHead ? '' : ' · older commit'}`
      : 'no CI run found'
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 30 - rowsAll.length)
    const differs = lo && ciRep && (lo.score !== ciRep.score || lo.passed !== ciRep.passed)
    const fixFor = r ?? auto

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text backgroundColor={C.accent} color={C.white} bold>{' ◉ '}</Text>
          <Text bold color={C.accent}> Quality gate  </Text>
          <Text color={C.info}>{name}</Text>
          <Text dimColor>  · {runLine}</Text>
        </Box>
        {r?.isUnknownSchema && <Text color={C.warn}>⚠ report schema version not known by this plugin: showing what could be read, update the plugin</Text>}
        {differs && <Text color={C.warn}>⚠ local and CI differ on {name}: push, or re-run the gate locally</Text>}

        <Box marginTop={1} marginBottom={1}>
          <Button
            key="fix"
            label="🔧 fix"
            variant="primary"
            onPress={() => {
              if (!fixFor || fixFor.feedback.length === 0) {
                $.ui.toast(fixFor ? 'The gate has nothing to fix.' : 'No gate report yet: re-run the gate first.')
                return
              }
              return $.prompt.fill({ text: fixesPrompt(fixFor, r ? sel.branch : name) })
            }}
          />
          <Text>  </Text>
          <Button key="rerun" label="↻ re-run" onPress={() => $.prompt.fill({ text: `Run ${RUNNER} run and summarize the gate result.` })} />
          <Text>  </Text>
          <Button key="refresh" label="⟳ refresh" dimColor onPress={() => Promise.all([refresh($), refreshOverview($)])} />
        </Box>

        {branchesSection(rowsAll, lo, name, sel, now, branchesIsOpen, Box, Text, Button, $)}

        {!r && (
          <Text dimColor>
            {sel.source === 'local'
              ? `No local report for ${sel.branch}. Run ${RUNNER} run on it.`
              : `No report for ${sel.branch} yet. Run ${RUNNER} run, or push and wait for CI.`}
          </Text>
        )}

        {r && (
          <Box flexDirection="column">
            <Box>
              <Text color={C.accent}>▍</Text>
              <Text bold>DETAIL  </Text>
              {pill(Text, r.passed ? 'PASSED' : 'FAILED', ratingColor(r))}
              <Text bold color={ratingColor(r)}>  {r.rating} {r.score}/100  </Text>
              <Text color={C.info}>{sel.branch}</Text>
              <Text dimColor>  · {r.source === 'ci' ? `CI${r.sha ? ' @' + r.sha.slice(0, 7) : ''}${sel.runId ? ' · run ' + sel.runId : ''}` : 'local run'}</Text>
            </Box>
            {card(
              Box,
              ratingColor(r),
              r.steps.map(s => (
                <Box>
                  {cell(Box, 8, pill(Text, STATUS_LABEL[s.status], COLOR[s.status]))}
                  {cell(Box, 18, <Text>{s.step}</Text>)}
                  {cell(Box, 18, scoreBar(Text, s.score, COLOR[s.status], 14))}
                  {cell(Box, 12, <Text dimColor>{s.score === null ? 'not scored' : String(s.score)}</Text>)}
                </Box>
              )),
            )}

            {r.blockers.length > 0 && (
              <Box flexDirection="column">
                <Text bold color={C.bad}>BLOCKERS <Text dimColor>the gate fails whatever the score</Text></Text>
                {card(Box, C.bad, r.blockers.map(b => <Text color={C.bad}>✘ {b}</Text>))}
              </Box>
            )}

            {r.feedback.length > 0 && (
              <Box flexDirection="column">
                {foldHeader(
                  Box,
                  Text,
                  Button,
                  'fold-fix',
                  fixIsOpen,
                  'WHAT TO FIX',
                  `${r.feedback.length} finding${r.feedback.length > 1 ? 's' : ''}, blockers first`,
                  C.warn,
                  () => update($, fixOpen, () => !fixIsOpen),
                )}
                {fixIsOpen &&
                  card(
                    Box,
                    C.warn,
                    <Box flexDirection="column">
                      {r.feedback.slice(0, room).map((f, i) => (
                        <Box flexDirection="column" marginBottom={1}>
                          <Text>
                            <Text bold color={C.accent}>{i + 1}.</Text> {pill(Text, f.step, f.status === 'fail' ? C.bad : C.warn)} {f.finding}
                          </Text>
                          <Text color={C.info}>   → {f.fix}</Text>
                        </Box>
                      ))}
                      {r.feedback.length > room && <Text dimColor>… {r.feedback.length - room} more in {RESULTS}/report.md</Text>}
                    </Box>,
                  )}
              </Box>
            )}
          </Box>
        )}
        {hint !== '' && <Text color={C.warn}>{hint}</Text>}
      </Box>
    )
  })
}
