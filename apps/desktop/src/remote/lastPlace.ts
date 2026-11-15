/**
 * Where the phone was, so it comes back there. A line that went quiet while
 * the app was in the background is reconnected by reloading the screens
 * (bridge.ts), and Android may recreate the app outright; either way the
 * screens would start over on the first project instead of the conversation
 * the person had open.
 */
import type { SessionTab } from "../store";

export type Place =
  | { kind: "session"; sessionId: string; workspaceId: string; tab: SessionTab }
  | { kind: "workspace"; workspaceId: string };

const PLACE_KEY = "thingmaker.remote.place";

export function rememberPlace(place: Place) {
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(place));
  } catch {
    // Without storage the screens start over after a reload.
  }
}

export function rememberedPlace(): Place | null {
  try {
    const raw = localStorage.getItem(PLACE_KEY);
    if (!raw) return null;
    const place = JSON.parse(raw) as Partial<Place> & Record<string, unknown>;
    if (typeof place.workspaceId !== "string") return null;
    if (place.kind === "workspace") return { kind: "workspace", workspaceId: place.workspaceId };
    if (place.kind === "session" && typeof place.sessionId === "string") {
      return { kind: "session", sessionId: place.sessionId, workspaceId: place.workspaceId, tab: typeof place.tab === "string" ? (place.tab as SessionTab) : "transcript" };
    }
    return null;
  } catch {
    return null;
  }
}
