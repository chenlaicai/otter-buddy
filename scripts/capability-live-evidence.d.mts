export interface SampleScenario { id: string; successes: number; valid: number; skipped: number; invalid: number }
export interface LiveProtocol {
  version: number; protocolId: string; alpha: number; multipleComparisons: string;
  runsPerSide: number; executionOrder: string; minimumValidSamplesPerSide: number; absoluteHeadSuccessFloor: number;
  nonInferiorityDelta: number; invalidSamplePolicy: string; notes?: string;
  referenceModel: { provider: string; model: string; baseUrl: string; thinkingLevel: string | null };
}
export interface RunManifest {
  version: number; kind: string; runId: string; role: string; sourceSha: string; mergeBaseSha: string; startedAt: string; endedAt: string;
  outcome: string; executionInvalid: boolean; exitCode: number; command: string; protocol: { id: string; sha256: string }; inventory: { sha256: string }; distWorkerSha256: string;
  hardFailures: string[]; invalidFailures: string[]; undeclaredSkips: string[]; inventoryErrors: string[];
  sampleThresholdFailures: string[]; actualTests: string[];
  manualReviewAttachment?: { attachedAt: string; reviewsSha256: string; originalManifestSha256: string };
  model: { provider: string; model: string; baseUrl: string; thinkingLevel: string | null; configSha256: string };
  harness: { sha256: string; overlay: boolean; overlayDiffSha256: string };
  log: { path: string; sha256: string; bytes: number };
  vitestResult: { sha256: string; total: number; failed: number } | null;
  manualReviews: Array<{ id: string; verdict: string; judged_by: string }>;
  scenarios: SampleScenario[];
}
export interface ScenarioComparison {
  id: string; status: string; reason: string; differenceCi?: [number, number];
  base?: { successes: number; valid: number }; head?: { successes: number; valid: number };
}
export interface LiveComparison {
  version: number; kind: string; outcome: string; protocolId?: string; protocol: LiveProtocol;
  base: { runIds: string[]; sourceSha: string; logSha256: string[]; runs: RunManifest[] };
  head: { runIds: string[]; sourceSha: string; logSha256: string[]; runs: RunManifest[] };
  model?: unknown; harnessSha256?: string; scenarioCount?: number;
  scenarios: ScenarioComparison[]; errors: string[];
}
export declare const CANONICAL_PROTOCOL: LiveProtocol;
export declare const CANONICAL_PROTOCOL_SHA256: string;
export declare const CANONICAL_INVENTORY_SHA256: string;
export declare const CANONICAL_INVENTORY: { testFullNames: string[]; sampledScenarioIds: string[]; manualReviewIds: string[]; declaredSkippedTestFullNames: string[] };
export declare function sha256(value: unknown): string;
export declare function sha256File(file: string): string;
export declare function loadJson(file: string): unknown;
export declare function validateProtocol(protocol: LiveProtocol): string[];
export declare function parseCapabilitySamples(logText: string): SampleScenario[];
export declare function hashCapabilityHarness(root: string): string;
export declare function createRunManifest(input: Record<string, unknown>): RunManifest;
export declare function normalQuantile(p: number): number;
export declare function wilsonInterval(successes: number, n: number, z: number): [number, number];
export declare function compareScenario(base: SampleScenario, head: SampleScenario, protocol: LiveProtocol, scenarioCount: number): ScenarioComparison;
export declare function compareCapabilityEvidence(base: RunManifest | RunManifest[], head: RunManifest | RunManifest[], protocol: LiveProtocol): LiveComparison;
export declare function validateRunInventory(run: RunManifest, inventory: typeof CANONICAL_INVENTORY): string[];
export declare function validateComparison(comparison: LiveComparison, expected?: { expectedHead?: string; expectedBase?: string; expectedProtocol?: LiveProtocol; expectedProtocolSha?: string; expectedInventory?: typeof CANONICAL_INVENTORY; expectedInventorySha?: string; expectedHarnessSha?: string }): string[];
