/**
 * More than one account per provider: the Providers panel lists them and
 * switches the active one, adding one starts its own sign-in, and the model
 * menu switches account, moving an idle conversation along.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_PROVIDERS, type AccountView, type TerminalInfo } from "@thingmaker/contracts";

const calls = vi.hoisted(() => ({ api: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("./ipc", () => ({
  api: new Proxy(calls.api, { get: (target, key: string) => (target[key] ??= vi.fn(async () => undefined)) }),
}));
import { api } from "./ipc";
import { useStore } from "./store";
import { ProviderAccounts } from "./components/ProviderAccounts";
import { ConfigPickers } from "./components/ConfigPickers";

const main: AccountView = { id: "default", provider: "claude", label: "", isDefault: true, active: true, auth: { provider: "claude", loggedIn: true, account: "me@work.example", plan: "max" } };
const personal: AccountView = { id: "acct-1", provider: "claude", label: "Personal", isDefault: false, active: false, auth: { provider: "claude", loggedIn: true, account: "me@home.example", plan: "pro" } };

beforeEach(() => {
  for (const key of Object.keys(calls.api)) delete calls.api[key];
  vi.mocked(api.accountsList).mockResolvedValue([main, personal]);
  vi.mocked(api.providerModels).mockResolvedValue([]);
  useStore.setState({ error: null, accounts: {}, providers: [], pendingProvider: {}, sessions: {}, sessionOrder: [], signIn: null, refreshUsage: vi.fn(async () => undefined), loadProviders: vi.fn(async () => undefined) } as never);
});
afterEach(cleanup);

describe("accounts in Providers", () => {
  it("lists each account with who it is, and makes one active", async () => {
    render(<ProviderAccounts provider="claude" />);
    expect(await screen.findByText("Main account")).toBeTruthy();
    expect(screen.getByText("me@home.example · pro")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Personal/ }));
    await waitFor(() => expect(api.accountSetActive).toHaveBeenCalledWith("claude", "acct-1"));
    expect(useStore.getState().accounts.claude?.find((account) => account.id === "acct-1")?.active).toBe(true);
  });

  it("adds an account and starts its own sign-in", async () => {
    vi.mocked(api.accountAdd).mockResolvedValue({ id: "acct-2", provider: "claude", label: "Work 2", isDefault: false, active: false });
    vi.mocked(api.providerLoginStart).mockResolvedValue({ runId: "r1" });
    render(<ProviderAccounts provider="claude" />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Add account" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account name" }), { target: { value: "Work 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and sign in" }));
    await waitFor(() => expect(api.accountAdd).toHaveBeenCalledWith("claude", "Work 2"));
    await waitFor(() => expect(api.providerLoginStart).toHaveBeenCalledWith("claude", expect.any(Function), "acct-2"));
  });
});

describe("the model menu", () => {
  it.each(["claude", "gemini"] as const)("switches %s account and moves the idle conversation to it", async (provider) => {
    vi.mocked(api.accountsList).mockResolvedValue([{ ...main, provider }, { ...personal, provider }]);
    const handle = { id: "s1", attachmentGeneration: "1" };
    useStore.setState({
      sessions: { s1: { handle, workspaceId: "w1", snapshot: { handle, provider, agentSessionId: "agent-1", configOptions: [] }, projection: { foreground: "idle", process: "running", cards: [] }, inFlightRequestId: null } },
      sessionOrder: ["s1"],
      records: {},
    } as never);
    vi.mocked(api.sessionOpen).mockRejectedValue(new Error("stop here"));
    const options = [{ id: "model", name: "Model", type: "select", currentValue: "opus", options: [{ value: "opus", name: "Opus 5.5" }] }];
    render(<ConfigPickers configOptions={options} disabled={false} sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /Opus 5.5/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Personal" }));
    await waitFor(() => expect(api.accountSetActive).toHaveBeenCalledWith(provider, "acct-1"));
    await waitFor(() => expect(api.sessionStop).toHaveBeenCalledWith(handle));
    await waitFor(() => expect(api.sessionOpen).toHaveBeenCalledWith(expect.objectContaining({ mode: { mode: "resume", session_id: "agent-1" }, provider })));
  });
});

describe("Gemini accounts", () => {
  const terminal: TerminalInfo = { id: "auth-t1", cwd: "/scratch", program: "agy", pid: 12, cols: 100, rows: 28, exited: false, exitCode: null };
  const work: AccountView = { ...personal, provider: "gemini", auth: { provider: "gemini", loggedIn: true } };

  it("offers Gemini accounts and uses the same active-account selector", async () => {
    expect(ACCOUNT_PROVIDERS).toContain("gemini");
    vi.mocked(api.accountsList).mockResolvedValue([{ ...main, provider: "gemini" }, work]);
    render(<ProviderAccounts provider="gemini" />);
    fireEvent.click(await screen.findByRole("radio", { name: /Personal/ }));
    await waitFor(() => expect(api.accountSetActive).toHaveBeenCalledWith("gemini", "acct-1"));
  });

  it("adds a Gemini account and opens its own interactive sign-in", async () => {
    vi.mocked(api.accountAdd).mockResolvedValue({ ...work, id: "acct-g" });
    vi.mocked(api.providerLoginTerminal).mockResolvedValue(terminal);
    await useStore.getState().addAccount("gemini", "Work");
    expect(api.providerLoginTerminal).toHaveBeenCalledWith("acct-g");
    expect(api.providerLoginStart).not.toHaveBeenCalled();
    expect(useStore.getState().signIn).toMatchObject({ provider: "gemini", account: "acct-g", terminal, state: "running" });
  });

  it("verifies sign-in before closing the terminal and refreshing the provider", async () => {
    vi.mocked(api.providerLoginTerminal).mockResolvedValue(terminal);
    vi.mocked(api.accountsList).mockResolvedValue([{ ...work, auth: { provider: "gemini", loggedIn: false } }]);
    await useStore.getState().startSignIn("gemini", "acct-1");
    await useStore.getState().finishGeminiSignIn();
    expect(api.terminalClose).not.toHaveBeenCalled();
    expect(useStore.getState().signIn?.state).toBe("running");
    vi.mocked(api.accountsList).mockResolvedValue([work]);
    await useStore.getState().finishGeminiSignIn();
    expect(api.terminalClose).toHaveBeenCalledWith("auth-t1");
    expect(useStore.getState().signIn?.state).toBe("success");
  });

  it("cancels the authentication terminal and allows another sign-in afterwards", async () => {
    vi.mocked(api.providerLoginTerminal).mockResolvedValue(terminal);
    await useStore.getState().startSignIn("gemini");
    expect(api.providerLoginTerminal).toHaveBeenCalledWith("default");
    await useStore.getState().startSignIn("gemini", "acct-1");
    expect(api.providerLoginTerminal).toHaveBeenCalledTimes(1);
    await useStore.getState().cancelSignIn();
    expect(api.terminalClose).toHaveBeenCalledWith("auth-t1");
    expect(useStore.getState().signIn?.state).toBe("cancelled");
    await useStore.getState().startSignIn("gemini", "acct-1");
    expect(api.providerLoginTerminal).toHaveBeenCalledTimes(2);
  });
});
