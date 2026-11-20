/**
 * The artifact panel's state.
 *
 * A claude.ai artifact opens beside the conversation in a native view that
 * the panel positions (claude.ai refuses to load in a frame). The phone and
 * any link that is not an artifact keep opening in the browser.
 */
import { useSyncExternalStore } from "react";
import { api } from "./ipc";
import { IS_REMOTE } from "./remote/mode";

/** A Claude artifact's page. */
export const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([\w-]+)/i;

export interface ArtifactView {
  /** The artifact on show, or null when the panel is closed. */
  url: string | null;
  /** Whether the panel takes the conversation's place. */
  full: boolean;
}

/** How wide the panel may be, in pixels; the conversation always keeps `rest`. */
export const ARTIFACT_WIDTH = { min: 360, initial: 620, rest: 380 };

const WIDTH_KEY = "thingmaker.artifact.width";
const listeners = new Set<() => void>();

function readWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? value : ARTIFACT_WIDTH.initial;
  } catch {
    return ARTIFACT_WIDTH.initial;
  }
}

// In development, `VITE_ARTIFACT_URL=<artifact link> pnpm dev` opens the panel at start, to try it without a conversation.
const preset = import.meta.env.DEV ? (import.meta.env.VITE_ARTIFACT_URL as string | undefined) : undefined;
let view: ArtifactView = { url: preset && ARTIFACT_URL.test(preset) ? preset : null, full: false };
let width = readWidth();

function change(next: ArtifactView): void {
  view = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether this link opens in the panel rather than the browser. */
export function opensInPanel(url: string): boolean {
  return !IS_REMOTE && ARTIFACT_URL.test(url);
}

export function openArtifact(url: string): void {
  change({ ...view, url });
}

export function closeArtifact(): void {
  change({ url: null, full: false });
}

export function setArtifactFull(full: boolean): void {
  change({ ...view, full });
}

export function useArtifactView(): ArtifactView {
  return useSyncExternalStore(subscribe, () => view);
}

/** A width the panel can take in a window this wide. */
export function clampArtifactWidth(wanted: number, viewport: number): number {
  const ceiling = Math.max(ARTIFACT_WIDTH.min, viewport - ARTIFACT_WIDTH.rest);
  return Math.round(Math.min(Math.max(wanted, ARTIFACT_WIDTH.min), ceiling));
}

export function setArtifactWidth(next: number): void {
  width = Math.round(next);
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Storage can be unavailable; the width still holds until reload.
  }
  listeners.forEach((listener) => listener());
}

export function useArtifactWidth(): number {
  return useSyncExternalStore(subscribe, () => width);
}

/* ---------- The native view ---------- */

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// One call at a time, in order: a hide that overtook a show would leave the panel empty.
let queue: Promise<unknown> = Promise.resolve();
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

export const nativeView = {
  show: (url: string, bounds: ViewBounds) => inOrder(() => api.artifactViewShow(url, bounds)),
  follow: (bounds: ViewBounds) => inOrder(() => api.artifactViewBounds(bounds)),
  hide: () => inOrder(() => api.artifactViewHide()),
};
