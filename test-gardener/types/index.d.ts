/** Tests the branch adds against the default branch, as `git diff` counts them; what the band above the prompt shows. */
export type BranchTests = {
  /** When the count was taken, in `$.clock.now()` milliseconds. */
  at: number
  /** Test definitions added in test files. */
  tests: number
  /** Lines added to test files. */
  lines: number
}

/** The plugin's settings, as the manifest's userConfig declares them. */
export type GardenerSettings = {
  /** Jaccard similarity of 5-token shingles from which two tests are near-duplicates; 0.9 and above is a clone. */
  nearDuplicate: number
  /** Tests per file beyond which a file is called out. */
  maxTestsPerFile: number
  /** New tests on the branch from which the band shows. */
  bigBranchTests: number
  /** Added test lines on the branch from which the band shows. */
  bigBranchLines: number
  /** Reserved; not implemented yet. */
  modelReview: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'test-gardener': { branch: BranchTests | null; isHidden: boolean }
  }
}
