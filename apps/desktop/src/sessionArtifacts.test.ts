import { describe, expect, it } from "vitest";
import type { ToolPatch } from "@thingmaker/contracts";
import type { Card, Projection } from "./projection";
import { sessionArtifacts } from "./sessionArtifacts";

function tool(id: string, toolName: string, rawInput: unknown, rawOutput: unknown, status = "completed"): ToolPatch {
  return {
    toolCallId: id, title: toolName, status, toolKind: "other", content: null, rawInput, rawOutput, name: null, locations: null,
    meta: { claudeCode: { toolName } }, present: [], cleared: [],
  } as unknown as ToolPatch;
}

function transcript(entries: (ToolPatch | { role: "agent" | "user" | "thought"; text: string })[]): Pick<Projection, "cards" | "toolCalls"> {
  const cards: Card[] = [];
  const toolCalls = new Map<string, ToolPatch>();
  entries.forEach((entry, index) => {
    if ("role" in entry) {
      const key = `${entry.role}|m${index}`;
      cards.push({ kind: "message", key, message: { key, role: entry.role, messageId: `m${index}`, blocks: [{ type: "text", text: entry.text }], contentUnknown: false } });
    } else {
      toolCalls.set(entry.toolCallId!, entry);
      cards.push({ kind: "tool", key: `tool|${entry.toolCallId}`, toolCallId: entry.toolCallId! });
    }
  });
  return { cards, toolCalls };
}

describe("the artifacts a conversation made", () => {
  it("lists published, updated, opened and linked artifacts, latest first, and leaves templates out", () => {
    const artifacts = sessionArtifacts(transcript([
      tool("q", "Artifact", { action: "quickstart", intent: "design" }, "Start from https://claude.ai/artifact/TypeTypeType1 for a design."),
      tool("c", "Artifact", { type_url: "https://claude.ai/artifact/TypeTypeType1", title: "Run Tracker" },
        [{ type: "text", text: "Created a new Artifact at https://claude.ai/artifact/Tracker111 (version 1) from the Artifact type https://claude.ai/artifact/TypeTypeType1." }]),
      tool("p1", "Artifact", { file_path: "/scratch/release-notes.html" }, "Published /scratch/release-notes.html at https://claude.ai/artifact/Notes2222 (Version 1, version id x)"),
      tool("p2", "Artifact", { file_path: "/scratch/release-notes.html" }, "Published /scratch/release-notes.html at https://claude.ai/artifact/Notes2222 (Version 2, version id y)"),
      tool("u", "Artifact", { url: "https://claude.ai/artifact/Old33333", file_path: "/scratch/old.html" }, "Updated the Artifact at https://claude.ai/artifact/Old33333 (Version 4)"),
      tool("f", "Artifact", { file_path: "/scratch/broken.html" }, "Publish refused: https://claude.ai/artifact/Nope4444", "failed"),
      tool("o", "Artifact", { action: "open", url: "https://claude.ai/artifact/Seen5555" }, "Opened."),
      tool("r", "Artifact", { action: "read", url: "https://claude.ai/artifact/Read6666" }, "Read https://claude.ai/artifact/Read6666"),
      { role: "agent", text: "Here are the [Release notes](https://claude.ai/artifact/Notes2222) and https://claude.ai/code/artifact/abc-123." },
      { role: "thought", text: "maybe https://claude.ai/artifact/Think777" },
    ]));
    expect(artifacts.map((a) => [a.id, a.title, a.action, a.publishes])).toEqual([
      ["abc-123", null, "linked", 0],
      ["Notes2222", "Release notes", "created", 2],
      ["Seen5555", null, "opened", 0],
      ["Old33333", "old", "updated", 1],
      ["Tracker111", "Run Tracker", "created", 1],
    ]);
    expect(artifacts[0]!.url).toBe("https://claude.ai/code/artifact/abc-123");
  });

  it("counts a Claude Docs document the agent created", () => {
    const [doc] = sessionArtifacts(transcript([
      tool("d", "mcp__claude_ai_Claude_Docs__batch", { container: { kind: "project", create: { name: "Q3 Plan" } }, batch: [] }, "Created https://claude.ai/artifact/Doc88888"),
      tool("e", "mcp__claude_ai_Claude_Docs__batch", { container: { kind: "project", id: "x" }, batch: [] }, "Edited https://claude.ai/artifact/Doc88888"),
    ]));
    expect(doc).toMatchObject({ id: "Doc88888", title: "Q3 Plan", action: "created", publishes: 1 });
  });

  it("is empty for a conversation without artifacts", () => {
    expect(sessionArtifacts(transcript([{ role: "agent", text: "Nothing to see at https://claude.ai/new" }]))).toEqual([]);
  });
});
