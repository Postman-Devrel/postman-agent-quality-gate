export type StepStatus = 'pass' | 'warn' | 'fail' | 'not_available'

export type GateStep = {
  step: string
  status: StepStatus
  score: number | null
}

export type GateFinding = { step: string; status: string; finding: string; fix: string }

/** The gate report (report.json written by the gate runner), plus where it comes from. */
export type GateReport = {
  source: 'local' | 'ci'
  passed: boolean
  score: number
  rating: string
  blockers: string[]
  feedback: GateFinding[]
  steps: GateStep[]
  /** Commit the report is about (CI reports only). */
  sha?: string
  /** The report carries a schema_version this plugin does not know: fields read best effort. */
  isUnknownSchema?: boolean
}

/** The latest CI run for the checked-out branch. */
export type CiRun = {
  id: number
  status: string
  conclusion: string
  sha: string
  isHead: boolean
  url: string
}

/** One line of the overview: the latest finished gate run of a branch, and its pull request if any. */
export type OverviewRow = {
  branch: string
  pr: number | null
  title: string
  /** Latest non-cancelled run: queued, in_progress or completed. */
  status: string
  conclusion: string
  rating: string
  score: number | null
  passed: boolean | null
  blockers: number
  sha: string
  runId: number
  /** ISO time the run was created. */
  updatedAt: string
  isCurrent: boolean
}

/** The analysis whose detail the pane shows: a branch's CI run, or the local run of the checked-out branch. */
export type GateSelection = { branch: string; source: 'local' | 'ci'; runId: number | null }

declare module 'claude-code' {
  interface PluginState {
    'postman-agent-quality-gate': {
      report: GateReport | null
      local: GateReport | null
      ciReport: GateReport | null
      run: CiRun | null
      branch: string
      note: string
      isHidden: boolean
      overview: OverviewRow[]
      /** null: the checked-out branch, its CI report for HEAD if any, else the local one. */
      selected: GateSelection | null
      /** The report of the selected CI run of another branch, read from <results dir>/ci/<run>/. */
      detail: GateReport | null
      fixOpen: boolean
      branchesOpen: boolean
    }
  }
}
