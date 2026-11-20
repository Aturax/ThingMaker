/**
 * The claude.ai artifacts a conversation published, opened or linked.
 *
 * Read from the transcript itself, so the list needs no storage and is the
 * same on every replay: the Artifact tool's publish and open calls, a Claude
 * Docs document's creation, and artifact links in the messages. An Artifact
 * type the agent started from is a template, not something this session made,
 * so its address is left out.
 */
import type { ContentBlock, ToolPatch } from "@thingmaker/contracts";
import type { Projection } from "./projection";

/** An artifact's address; the first group is its id. Global, for scanning text. */
const ADDRESS = /https:\/\/claude\.ai\/(?:code\/)?artifact\/([\w-]+)/g;
/** A Markdown link to one, `[label](address)`. */
const LABELLED = /\[([^\]\n]{1,200})\]\((https:\/\/claude\.ai\/(?:code\/)?artifact\/([\w-]+))[^)\s]*\)/g;

/** What the session did with an artifact, strongest first. */
export type ArtifactAction = "created" | "updated" | "opened" | "linked";

export interface SessionArtifact {
  id: string;
  url: string;
  /** A name for it, when the session gave one. */
  title: string | null;
  /** The strongest thing the session did with it. */
  action: ArtifactAction;
  /** How many times the agent published it (a create counts). */
  publishes: number;
  /** Order of its last appearance in the transcript; higher is later. */
  last: number;
}

const STRENGTH: Record<ArtifactAction, number> = { created: 3, updated: 2, opened: 1, linked: 0 };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The tool's own name, which the Claude adapter sends in `_meta`. */
function toolName(patch: ToolPatch): string | null {
  const name = record(record(patch.meta)?.claudeCode)?.toolName;
  return typeof name === "string" ? name : patch.title;
}

/** The text of a tool's result, which is a string or a list of content blocks. */
export function outputText(output: unknown, depth = 0): string {
  if (typeof output === "string") return output;
  if (depth > 4) return "";
  if (Array.isArray(output)) return output.map((item) => outputText(item, depth + 1)).join("\n");
  const item = record(output);
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (item.content !== undefined) return outputText(item.content, depth + 1);
  return "";
}

function firstAddress(text: string): { id: string; url: string } | null {
  ADDRESS.lastIndex = 0;
  const match = ADDRESS.exec(text);
  return match ? { id: match[1]!, url: match[0] } : null;
}

/** A file name as a title: `release-notes.html` reads "release-notes". */
function fileTitle(path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.replace(/\.[^.]+$/, "") || null;
}

function textOf(blocks: ContentBlock[]): string {
  return blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

export function sessionArtifacts(projection: Pick<Projection, "cards" | "toolCalls">): SessionArtifact[] {
  const found = new Map<string, SessionArtifact & { named: boolean }>();
  const templates = new Set<string>();
  let order = 0;

  const note = (id: string, url: string, action: ArtifactAction, title: string | null, named = false) => {
    order += 1;
    const existing = found.get(id);
    if (!existing) {
      found.set(id, { id, url, title, action, publishes: action === "created" || action === "updated" ? 1 : 0, last: order, named });
      return;
    }
    if (STRENGTH[action] > STRENGTH[existing.action]) existing.action = action;
    if (action === "created" || action === "updated") existing.publishes += 1;
    // A label the agent wrote beats a file name; a later label beats an earlier one.
    if (title && (named || !existing.named)) {
      existing.title = title;
      existing.named = existing.named || named;
    }
    existing.last = order;
  };

  for (const card of projection.cards) {
    if (card.kind === "tool") {
      const patch = projection.toolCalls.get(card.toolCallId);
      if (!patch) continue;
      const name = toolName(patch) ?? "";
      const input = record(patch.rawInput) ?? {};
      if (name === "Artifact") {
        const action = typeof input.action === "string" ? input.action : "publish";
        if (typeof input.type_url === "string") templates.add(firstAddress(input.type_url)?.id ?? "");
        if (action === "publish" && patch.status === "completed" && input.asset !== true) {
          // The result starts with the artifact's address ("Created a new
          // Artifact at …", "Updated the Artifact at …", "Published … at …").
          const at = firstAddress(outputText(patch.rawOutput));
          if (!at) continue;
          const created = /^\s*(Created|Published\b[^\n]*\(Version 1\b)/.test(outputText(patch.rawOutput));
          const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : fileTitle(input.file_path);
          note(at.id, at.url, created ? "created" : "updated", title);
        } else if (action === "open" && typeof input.url === "string") {
          const at = firstAddress(input.url);
          if (at) note(at.id, at.url, "opened", null);
        }
      } else if (/Claude_Docs__batch$/.test(name) && patch.status === "completed" && record(record(input.container)?.create)) {
        const at = firstAddress(outputText(patch.rawOutput));
        if (!at) continue;
        const create = record(record(input.container)?.create);
        const title = typeof create?.name === "string" && create.name.trim() ? create.name.trim() : null;
        note(at.id, at.url, "created", title);
      }
    } else if (card.kind === "message" && card.message.role !== "thought") {
      const text = textOf(card.message.blocks);
      const labelled = new Set<string>();
      for (const match of text.matchAll(LABELLED)) {
        labelled.add(match[3]!);
        note(match[3]!, match[2]!, "linked", match[1]!.trim(), true);
      }
      for (const match of text.matchAll(ADDRESS)) {
        if (!labelled.has(match[1]!)) note(match[1]!, match[0], "linked", null);
      }
    }
  }

  return [...found.values()]
    .filter((artifact) => !templates.has(artifact.id) || artifact.action !== "linked")
    .sort((a, b) => b.last - a.last)
    .map(({ named: _named, ...artifact }) => artifact);
}
