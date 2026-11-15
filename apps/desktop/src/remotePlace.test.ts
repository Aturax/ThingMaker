import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Snapshot } from "@thingmaker/contracts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("./remote/mode", () => ({ IS_REMOTE: true }));
// Every call answers nothing; the two the start needs answer the workspaces.
vi.mock("./ipc", () => ({
  api: new Proxy({} as Record<string, unknown>, {
    get: (target, name: string) =>
      (target[name] ??= vi.fn(async () => {
        if (name === "workspaceList") return [{ id: "w1", canonicalRoot: "/a" }, { id: "w2", canonicalRoot: "/b" }];
        if (name === "executionProfiles") return [];
        return null;
      })),
  }),
}));

import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { emptyProjection } from "./projection";

function liveSession(id: string, workspaceId: string): LiveSession {
  const handle = { id, attachmentGeneration: "1" };
  return {
    handle, workspaceId, snapshot: { handle, provider: "claude" } as Snapshot,
    projection: emptyProjection(), inFlightRequestId: null, steerInFlight: false, attention: "none",
    openedAt: 0, turnStartedAt: null, lastEventAt: 0, usage: EMPTY_SESSION_USAGE,
  } as LiveSession;
}

const initial = useStore.getState();
const tick = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval"] });
  localStorage.clear();
  useStore.setState({ ...initial, sessions: {}, sessionOrder: [], view: { kind: "welcome" } }, true);
});
afterEach(() => vi.useRealTimers());

/** The screens as they start, before the person goes anywhere. */
async function start() {
  useStore.setState({ rehydrate: async () => undefined });
  await useStore.getState().bootstrap();
  await tick();
}

it("returns to the open conversation after the screens restart", async () => {
  await start();
  // The person is in a conversation on the second project's files panel...
  useStore.setState({ sessions: { s9: liveSession("s9", "w2") } });
  useStore.setState({ sessionTab: "files" });
  useStore.getState().setView({ kind: "session", sessionId: "s9" });
  await tick();

  // ...then the screens start over (a reconnect reloads them) and the live
  // session is attached again by rehydrate.
  useStore.setState({ ...initial, sessions: {}, sessionOrder: [], view: { kind: "welcome" } }, true);
  useStore.setState({ rehydrate: async () => useStore.setState({ sessions: { s9: liveSession("s9", "w2") } }) });
  await useStore.getState().bootstrap();
  await tick();

  expect(useStore.getState().view).toEqual({ kind: "session", sessionId: "s9" });
  expect(useStore.getState().sessionTab).toBe("files");
});

it("falls back to that conversation's project when it is no longer open", async () => {
  await start();
  useStore.setState({ sessions: { s9: liveSession("s9", "w2") } });
  useStore.getState().setView({ kind: "session", sessionId: "s9" });
  await tick();

  useStore.setState({ ...initial, sessions: {}, sessionOrder: [], view: { kind: "welcome" } }, true);
  useStore.setState({ rehydrate: async () => undefined });
  await useStore.getState().bootstrap();
  await tick();

  expect(useStore.getState().view).toEqual({ kind: "workspace", workspaceId: "w2" });
});

it("still opens the first project when nothing was remembered", async () => {
  await start();

  expect(useStore.getState().view).toEqual({ kind: "workspace", workspaceId: "w1" });
});
