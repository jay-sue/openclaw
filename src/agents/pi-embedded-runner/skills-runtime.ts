/**
 * 解析本次嵌入式运行使用的技能条目：若无 skillsSnapshot.resolvedSkills 则从 workspace 加载，否则用快照。
 */
import type { OpenClawConfig } from "../../config/config.js";
import { loadWorkspaceSkillEntries, type SkillEntry, type SkillSnapshot } from "../skills.js";

/** 根据 skillsSnapshot 决定是否加载技能；需要加载时从 workspaceDir + config 加载 SkillEntry 列表 */
export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
} {
  const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
  return {
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(params.workspaceDir, { config: params.config })
      : [],
  };
}
