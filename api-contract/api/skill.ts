/**
 * #576 (F20260901emps): Skills 目录 DTO——能力库页面真数据源。
 *
 * Why: 此前页面数据是静态快照（9/11 个 skill，随仓库演化过时）。
 * 真相源 = pi-agent ResourceLoader 发现的 skill 集合（.pi/skills 目录各 SKILL.md frontmatter），
 * 与 otter 实际加载的 skill 一致——页面所见即系统所载。
 */

export interface SkillItemDTO {
  /** skill 名（= 目录名，路由键） */
  name: string;
  /** frontmatter description（三段式契约摘要） */
  description: string;
}

export interface SkillListDTO {
  skills: SkillItemDTO[];
}
