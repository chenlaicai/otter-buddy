export interface CapabilityGuardrailEntry {
  file: string;
  trigger: string;
  effect: string;
  consumer: string;
  guarantee: "structure" | "runtime-guard" | "equivalence" | "faux" | "live" | "mechanism" | "none";
  faux: "run" | "exclude";
  issue?: string;
}
export interface CapabilityRegistry {
  version: 1;
  changeTrigger: {
    paths: string[];
    parityTest: string;
    liveCommand: string;
  };
  capabilities: CapabilityGuardrailEntry[];
}
export declare const GUARANTEE_LAYERS: Set<CapabilityGuardrailEntry["guarantee"]>;
export declare function loadCapabilityRegistry(root?: string): CapabilityRegistry;
export declare function globToRegExp(glob: string): RegExp;
export declare function matchingCapabilityChanges(changedPaths: string[], registry: CapabilityRegistry): string[];
export declare function validateCapabilityGuardrails(root?: string, registry?: CapabilityRegistry): string[];
