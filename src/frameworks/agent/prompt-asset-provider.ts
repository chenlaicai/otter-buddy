import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatSkillsForPrompt, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { getRepoRoot } from "@frameworks/repo-root";

export interface PromptAssetSnapshot {
  readonly systemPrompt: string;
  readonly skillsPrompt: string;
  readonly revisions: Readonly<{ system: string; skills: string }>;
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Reloads source assets at the invoke boundary; hashes only avoid rebuilding equal snapshots. */
export class PromptAssetProvider {
  private cached?: PromptAssetSnapshot;
  private loading: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly resourceLoader: () => ResourceLoader | null,
    private readonly root: string = getRepoRoot(),
  ) {}

  snapshot(): Promise<PromptAssetSnapshot> {
    // Why: the ResourceLoader is shared by all otters. Serialize reloads so
    // concurrent invokes cannot observe a half-replaced skill index; a failed
    // load rejects its own invoke but leaves the queue usable for the next one.
    const result = this.loading.then(() => this.load());
    this.loading = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<PromptAssetSnapshot> {
    const systemPath = path.join(this.root, ".pi", "SYSTEM.md");
    let systemPrompt: string;
    try {
      systemPrompt = await readFile(systemPath, "utf8");
    } catch (error) {
      throw new Error(`Prompt asset SYSTEM.md is unreadable: ${systemPath}`, { cause: error });
    }
    if (!systemPrompt.trim()) throw new Error(`Prompt asset SYSTEM.md is empty: ${systemPath}`);

    const loader = this.resourceLoader();
    if (!loader) throw new Error("Prompt asset ResourceLoader is unavailable; warmup must complete before invoke");
    let skillsPrompt: string;
    try {
      // Why: ResourceLoader warmup is only the initial discovery point. Reloading here
      // makes SKILL.md additions and description changes visible on the next invoke.
      await loader.reload();
      const result = loader.getSkills();
      const errors = result.diagnostics.filter(diagnostic => diagnostic.type === "error");
      if (errors.length) {
        throw new Error(errors.map(diagnostic => `${diagnostic.path ?? "skill"}: ${diagnostic.message}`).join("; "));
      }
      skillsPrompt = formatSkillsForPrompt(result.skills);
    } catch (error) {
      throw new Error("Prompt asset Skill index could not be loaded", { cause: error });
    }

    const revisions = Object.freeze({ system: contentHash(systemPrompt), skills: contentHash(skillsPrompt) });
    if (this.cached?.revisions.system === revisions.system && this.cached.revisions.skills === revisions.skills) {
      return this.cached;
    }
    this.cached = Object.freeze({ systemPrompt, skillsPrompt, revisions });
    return this.cached;
  }
}
