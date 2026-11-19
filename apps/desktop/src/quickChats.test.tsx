/**
 * Quick chats: listed apart from projects, started from the sidebar, shown
 * as their conversation alone with the Temporary switch, and deleted only
 * after asking.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuickChat, SessionRecord, Snapshot, WorkspaceRecord } from "@thingmaker/contracts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }) }));

import { api } from "./ipc";
import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { emptyProjection } from "./projection";
import { Sidebar } from "./components/Sidebar";
import { SessionPanel } from "./components/SessionPanel";
import { WorkspaceView } from "./components/WorkspaceView";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const initial = useStore.getState();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useStore.setState(initial, true);
});

const workspace = (id: string, path: string): WorkspaceRecord => ({ id, environmentId: "e", canonicalRoot: path, displayPath: path, workspaceHash: id, trustState: "trusted_local", createdAt: 0 });
const inspection = (record: WorkspaceRecord) => ({ identity: { canonicalRoot: record.canonicalRoot, displayPath: record.displayPath }, record, sources: [], trustStale: false, trustDigest: "d" }) as never;
const chat = (workspaceId: string, extra: Partial<QuickChat> = {}): QuickChat => ({ workspaceId, temporary: false, createdAt: 1, ...extra });
const record = (workspaceId: string, agentSessionId: string, title: string): SessionRecord =>
  ({ id: `row-${agentSessionId}`, workspaceId, agentSessionId, origin: "desktop", archiveState: "active", pinned: false, provider: "claude", createdAt: 0, titleOverlay: title }) as SessionRecord;

const project = workspace("p1", "/Users/someone/game");
const fresh = workspace("q1", "/data/quick-chats/aaaa");
const talked = workspace("q2", "/data/quick-chats/bbbb");
const leaving = workspace("q3", "/data/quick-chats/cccc");

function seedSidebar() {
  useStore.setState({
    workspaces: [project, fresh, talked, leaving],
    inspections: { p1: inspection(project), q1: inspection(fresh), q2: inspection(talked), q3: inspection(leaving) },
    records: { p1: [], q1: [], q2: [record("q2", "agent-2", "Regex for dates")], q3: [record("q3", "agent-3", "Old secret chat")] },
    quickChats: [chat("q1", { createdAt: 3 }), chat("q2", { createdAt: 2, temporary: true }), chat("q3", { temporary: true, deleting: true })],
    sessions: {},
    sessionOrder: [],
  });
}

describe("the sidebar", () => {
  it("lists quick chats under their own heading, not as projects, and hides one being deleted", () => {
    seedSidebar();
    render(<Sidebar />);
    const section = screen.getByText("Quick Chats").closest("section") as HTMLElement;
    expect(within(section).getByText("New chat")).toBeTruthy();
    expect(within(section).getByText("Regex for dates")).toBeTruthy();
    expect(within(section).getAllByTitle("Temporary chat: deleted when ThingMaker quits")).toHaveLength(1);
    expect(screen.queryByText("Old secret chat")).toBeNull();
    expect(screen.queryByText("aaaa")).toBeNull();
    expect(screen.getByText("game")).toBeTruthy();
  });

  it("starts a quick chat from the button beside the sidebar toggle", async () => {
    const created = workspace("q9", "/data/quick-chats/zzzz");
    const create = vi.spyOn(api, "quickChatCreate").mockResolvedValue({ chat: chat("q9"), workspace: created });
    vi.spyOn(api, "workspaceList").mockResolvedValue([created]);
    vi.spyOn(api, "workspaceInspect").mockResolvedValue(inspection(created));
    render(<Sidebar />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "New quick chat" })[0]!);
    });
    expect(create).toHaveBeenCalledWith(false);
    expect(useStore.getState().quickChats.map((entry) => entry.workspaceId)).toEqual(["q9"]);
    expect(useStore.getState().view).toEqual({ kind: "workspace", workspaceId: "q9" });
  });

  it("makes a quick chat temporary, and deletes it only after asking", async () => {
    seedSidebar();
    const setTemporary = vi.spyOn(api, "quickChatSetTemporary").mockResolvedValue(chat("q1", { temporary: true }));
    const confirm = vi.spyOn(api, "confirmDialog").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const remove = vi.spyOn(api, "quickChatDelete").mockResolvedValue(undefined);
    render(<Sidebar />);

    fireEvent.contextMenu(screen.getByText("New chat"));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Make temporary" }));
    });
    expect(setTemporary).toHaveBeenCalledWith("q1", true);

    fireEvent.contextMenu(screen.getByText("New chat"));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete chat…" }));
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByText("New chat"));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete chat…" }));
    });
    expect(remove).toHaveBeenCalledWith("q1");
    expect(useStore.getState().workspaces.some((entry) => entry.id === "q1")).toBe(false);
    expect(useStore.getState().quickChats.some((entry) => entry.workspaceId === "q1")).toBe(false);
  });
});

describe("a quick chat", () => {
  it("opens on a question and a composer with the Temporary switch, not a project page", () => {
    useStore.setState({ workspaces: [fresh], inspections: { q1: inspection(fresh) }, records: { q1: [] }, quickChats: [chat("q1")] });
    render(<WorkspaceView workspaceId="q1" />);
    expect(screen.getByText("What's on your mind?")).toBeTruthy();
    expect(screen.getByPlaceholderText("Ask anything")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Temporary chat", pressed: false })).toBeTruthy();
  });

  it("shows only its conversation, with the Temporary switch and what it means", () => {
    const handle = { id: "quick-session", attachmentGeneration: "1" };
    const projection = emptyProjection();
    projection.process = "ready";
    projection.attachment = "attached";
    const session: LiveSession = { handle, workspaceId: "q1", snapshot: { handle, provider: "claude" } as Snapshot, projection, inFlightRequestId: null, steerInFlight: false, attention: "none", openedAt: 0, turnStartedAt: null, lastEventAt: null, usage: EMPTY_SESSION_USAGE };
    useStore.setState({ workspaces: [fresh], quickChats: [chat("q1", { temporary: true })], sessions: { [handle.id]: session }, drafts: {}, attachments: {}, mentions: {}, sessionTab: "changes" });
    render(<SessionPanel sessionId={handle.id} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: /Views/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Temporary chat: on", pressed: true })).toBeTruthy();
    expect(screen.getByText(/Your provider still handles it under your account's settings/)).toBeTruthy();
  });
});
