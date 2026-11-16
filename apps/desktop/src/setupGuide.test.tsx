/**
 * The first-run guide: a missing provider installs, a signed-in one lets
 * the guide go on, a folder is trusted in place, the default teams load,
 * and "I'll chat later!" finishes it on the project's home.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@thingmaker/contracts";

const calls = vi.hoisted(() => ({ api: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("./ipc", () => ({
  api: new Proxy(calls.api, { get: (target, key: string) => (target[key] ??= vi.fn(async () => undefined)) }),
}));
import { api } from "./ipc";
import { useStore } from "./store";
import { SetupGuide } from "./components/SetupGuide";
import { DEFAULT_TEAMS } from "./defaultTeams";
import { readSetup, writeSetup } from "./setupProgress";

const resolved = { program: "/bin/x", prefixArgs: [], source: "discovered" };
const provider = (name: ProviderInfo["provider"], state: "missing" | "out" | "in"): ProviderInfo =>
  ({
    provider: name,
    label: name,
    ...(state === "missing" ? { problem: "not installed" } : { resolved, auth: { provider: name, loggedIn: state === "in", ...(state === "in" ? { plan: "Max" } : {}) } }),
  }) as unknown as ProviderInfo;

const inspection = (trust: "untrusted" | "trusted_local") => ({
  identity: { canonicalRoot: "/Users/someone/my-app", displayPath: "/Users/someone/my-app", workspaceHash: "h" },
  record: { id: "w1", trustState: trust },
  sources: [{ path: ".mcp.json", kind: "mcp", present: true, bytes: 10, executable: true, summary: [] }],
  trustDigest: "d",
  trustStale: false,
  isGitRepository: true,
  isUnityProject: false,
});

const loadProviders = vi.fn(async () => undefined);

beforeEach(() => {
  for (const key of Object.keys(calls.api)) delete calls.api[key];
  localStorage.clear();
  loadProviders.mockClear();
  useStore.setState({
    providers: [provider("claude", "missing"), provider("codex", "out"), provider("gemini", "missing"), provider("local", "missing")],
    workspaces: [],
    inspections: {},
    teamPresets: [],
    signIn: null,
    loadProviders,
  } as never);
});
afterEach(cleanup);

describe("the first-run guide", () => {
  it("installs a missing provider and asks for the providers again", async () => {
    vi.mocked(api.providerInstall).mockResolvedValue("added 1 package");
    render(<SetupGuide onFinish={() => undefined} />);
    expect(screen.getByText("Not on this computer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(api.providerInstall).toHaveBeenCalledWith("claude"));
    await waitFor(() => expect(loadProviders.mock.calls.length).toBeGreaterThan(1));
  });

  it("says Node.js is needed, with a way to get it, when npm is missing", async () => {
    vi.mocked(api.providerInstall).mockRejectedValue(new Error("Node.js is needed to install this. Get it from nodejs.org, then press Install again."));
    render(<SetupGuide onFinish={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect((await screen.findByRole("alert")).textContent).toContain("nodejs.org");
    expect(screen.getByRole("button", { name: "Get Node.js" })).toBeTruthy();
  });

  it("stays on the providers after the first sign-in until Continue", () => {
    useStore.setState({ providers: [provider("claude", "in"), provider("codex", "out")] } as never);
    render(<SetupGuide onFinish={() => undefined} />);
    expect(screen.getByText("Ready · Max")).toBeTruthy();
    // Codex can still be signed in to from here.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Choose a folder/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: /Choose a folder/ })).toBeTruthy();
    expect(readSetup()?.continued).toBe(true);
  });

  it("adds a folder without leaving the guide, and trusts it in place", async () => {
    useStore.setState({ providers: [provider("claude", "in")] } as never);
    writeSetup({ continued: true });
    vi.mocked(api.workspacePick).mockResolvedValue("/Users/someone/my-app");
    vi.mocked(api.workspaceInspect).mockResolvedValue(inspection("untrusted") as never);
    vi.mocked(api.workspaceList).mockResolvedValue([{ id: "w1", displayPath: "/Users/someone/my-app", canonicalRoot: "/Users/someone/my-app", trustState: "untrusted" }] as never);
    render(<SetupGuide onFinish={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Choose a folder/ }));
    expect(await screen.findByText("1 item can run commands")).toBeTruthy();
    expect(useStore.getState().view.kind).not.toBe("workspace");

    vi.mocked(api.workspaceTrust).mockResolvedValue(inspection("trusted_local") as never);
    vi.mocked(api.workspaceList).mockResolvedValue([{ id: "w1", displayPath: "/Users/someone/my-app", canonicalRoot: "/Users/someone/my-app", trustState: "trusted_local" }] as never);
    fireEvent.click(screen.getByRole("button", { name: "Trust and continue" }));
    expect(await screen.findByText("my-app · trusted")).toBeTruthy();
    expect(screen.getByText("Teams aren't required.")).toBeTruthy();
  });

  it("loads the default teams, then finishes with I'll chat later!", async () => {
    useStore.setState({
      providers: [provider("claude", "in"), provider("codex", "in")],
      workspaces: [{ id: "w1", displayPath: "/Users/someone/my-app", canonicalRoot: "/Users/someone/my-app", trustState: "trusted_local" }],
      inspections: { w1: inspection("trusted_local") },
    } as never);
    writeSetup({ continued: true });
    const onFinish = vi.fn();
    render(<SetupGuide onFinish={onFinish} />);
    fireEvent.click(screen.getByRole("button", { name: `Load the ${DEFAULT_TEAMS.length} default teams` }));
    expect(await screen.findByText("Default teams added")).toBeTruthy();
    expect(useStore.getState().teamPresets.map((preset) => preset.name)).toEqual(expect.arrayContaining(DEFAULT_TEAMS.map((entry) => entry.name)));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "I'll chat later!" }));
    });
    expect(onFinish).toHaveBeenCalled();
    expect(readSetup()?.finished).toBe(true);
    expect(useStore.getState().view).toEqual({ kind: "workspace", workspaceId: "w1" });
  });

  it("finishes at once with Skip for now", () => {
    const onFinish = vi.fn();
    render(<SetupGuide onFinish={onFinish} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onFinish).toHaveBeenCalled();
    expect(readSetup()?.finished).toBe(true);
  });
  it("starts an installed Ollama that is stopped, instead of asking for it", async () => {
    useStore.setState({
      providers: [provider("claude", "in"), provider("codex", "in"), provider("local", "out")],
      workspaces: [{ id: "w1", displayPath: "/Users/someone/my-app", canonicalRoot: "/Users/someone/my-app", trustState: "trusted_local" }],
      inspections: { w1: inspection("trusted_local") },
    } as never);
    writeSetup({ continued: true });
    render(<SetupGuide onFinish={() => undefined} />);
    expect(screen.queryByText(/Needs Ollama/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start Ollama" }));
    await waitFor(() => expect(api.localStart).toHaveBeenCalled());
    await waitFor(() => expect(loadProviders.mock.calls.length).toBeGreaterThan(1));
  });
});
