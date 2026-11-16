/**
 * The premade teams "Load defaults" adds on the Teams page: tried mixes of
 * Claude, Codex and local models. Names and notes stay in English because the
 * lead agent reads them as instructions.
 *
 * Loading adds only the ones whose name is not already here, so pressing it
 * twice, or after renaming nothing, never makes copies.
 */
import type { TeamPreset } from "@thingmaker/contracts";
import { newPreset } from "./team";
import type { TeamFileEntry } from "./teamFile";

const REVIEW_NOTE = "Checks another worker's result before it counts as done";

export const DEFAULT_TEAMS: readonly TeamFileEntry[] = [
  {
    name: "Big Brain",
    orchestrator: { provider: "claude", model: "opus", effort: "xhigh" },
    combo: {
      workers: [
        { name: "Astra", provider: "codex", model: "gpt-6-astra", effort: "xhigh", capabilities: ["review"], note: "Heavy review and research work." },
        { name: "Coder", provider: "codex", model: "gpt-6.1-terra", effort: "xhigh", capabilities: ["fast"], note: "Use when Claude usage is below 30% for coding" },
        { name: "Checker", provider: "claude", model: "fable", effort: "high", capabilities: ["review"], note: REVIEW_NOTE },
      ],
      nativeSubagents: false,
    },
  },
  {
    name: "Full Codex",
    orchestrator: { provider: "codex", model: "gpt-6.1-sol", effort: "high" },
    combo: {
      workers: [
        { name: "Quick Terra", provider: "codex", model: "gpt-6.1-terra", effort: "high", capabilities: ["fast"], note: "Small, quick edits" },
        { name: "Quick Luna", provider: "codex", model: "gpt-6-luna", effort: "xhigh", capabilities: ["image", "ui"], note: "Images, icons and UI art" },
        { name: "Reviewer", provider: "codex", model: "gpt-6-astra", effort: "high", capabilities: ["review"], note: REVIEW_NOTE },
      ],
      nativeSubagents: true,
    },
  },
  {
    name: "Local",
    orchestrator: { provider: "local", model: "@agent/llama3.1:8b" },
    combo: {
      workers: [{ name: "Coder", provider: "local", model: "@agent/llama3.1:8b", capabilities: ["review"], note: REVIEW_NOTE }],
      nativeSubagents: false,
    },
  },
  {
    name: "Opus 5.5 + Artist + Quick Sonnet",
    orchestrator: { provider: "claude", model: "opus", effort: "xhigh" },
    combo: {
      workers: [
        { name: "Luna Artist", provider: "codex", model: "gpt-6-luna", effort: "xhigh", capabilities: ["image", "ui"], note: "All image generation and editing: sprites, icons, UI art, backgrounds. Not for code." },
        { name: "Quick Sonnet", provider: "claude", model: "sonnet", effort: "high", capabilities: ["fast"], note: "Mechanical, specified edits. Not for design decisions or anything that needs exploring." },
      ],
      nativeSubagents: true,
    },
  },
  {
    name: "PR Reviewer",
    orchestrator: { provider: "claude", model: "fable", effort: "xhigh" },
    combo: {
      workers: [
        { name: "correctness", provider: "codex", model: "gpt-6-astra", effort: "xhigh", capabilities: ["review"], note: "Looks for bugs: wrong logic, missed edge cases, broken contracts between parts." },
        { name: "tests", provider: "claude", model: "opus", effort: "xhigh", capabilities: ["review"], note: "Checks the change is tested, and that the tests would fail if it broke." },
        { name: "devils-advocate", provider: "codex", model: "gpt-6.1-sol", effort: "xhigh", capabilities: ["review"], note: "Argues against the change: risks, simpler alternatives, what could go wrong in use." },
      ],
      nativeSubagents: false,
    },
  },
];

/** The default teams not already here (by name, ignoring case), as new saved teams. */
export function missingDefaultTeams(existing: readonly TeamPreset[]): TeamPreset[] {
  const taken = new Set(existing.map((preset) => preset.name.trim().toLowerCase()));
  return DEFAULT_TEAMS.filter((entry) => !taken.has(entry.name.toLowerCase())).map((entry) => ({
    ...newPreset(entry.name, []),
    orchestrator: { ...entry.orchestrator },
    combo: { workers: entry.combo.workers.map((worker) => ({ ...worker, capabilities: [...worker.capabilities] })), nativeSubagents: entry.combo.nativeSubagents },
  }));
}
