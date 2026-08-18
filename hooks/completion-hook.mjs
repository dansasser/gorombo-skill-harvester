#!/usr/bin/env node
import { runCompletionHook } from "../src/completion-hook.js";

try {
  const result = await runCompletionHook();
  process.stdout.write(JSON.stringify({ continue: true, goromboSkillHarvester: result.status }) + "\n");
} catch (error) {
  const code = String(error && error.message || "hook_failed");
  const onboarding = code === "onboarding_required";
  process.stdout.write(JSON.stringify({
    continue: true,
    systemMessage: onboarding
      ? "Gorombo Skill Harvester needs onboarding before it can harvest completed goals. Run gorombo-skill-harvester status."
      : "Gorombo Skill Harvester could not queue this completed goal. Run gorombo-skill-harvester status."
  }) + "\n");
}
