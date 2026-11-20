/**
 * A claude.ai artifact beside the conversation.
 *
 * The page is a native view laid over this panel's body, so the body only
 * reports where it is. Drag the left edge to resize; the header expands the
 * panel over the conversation, opens the artifact in the browser, or closes it.
 */
import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  ARTIFACT_URL, ARTIFACT_WIDTH, clampArtifactWidth, closeArtifact, nativeView, setArtifactFull, setArtifactWidth,
  useArtifactView, useArtifactWidth, type ViewBounds,
} from "../artifactView";
import { t } from "../i18n";
import { useStore } from "../store";
import { IconExternal, IconSpark, IconX } from "./icons";

function useViewportWidth(): number {
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const follow = () => setViewport(window.innerWidth);
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, []);
  return viewport;
}

function boundsOf(node: HTMLElement): ViewBounds {
  const rect = node.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

export function ArtifactPanel() {
  const { url, full } = useArtifactView();
  const openUrl = useStore((s) => s.openUrl);
  const stored = useArtifactWidth();
  const viewport = useViewportWidth();
  const [live, setLive] = useState<number | null>(null);
  const [problem, setProblem] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; live: number } | null>(null);
  const width = live ?? clampArtifactWidth(stored, viewport);

  // The native view follows the body for as long as the panel is open.
  const open = url !== null;
  useEffect(() => {
    const node = body.current;
    if (!open || !node) return;
    const follow = () => void nativeView.follow(boundsOf(node)).catch(() => undefined);
    const observer = new ResizeObserver(follow);
    observer.observe(node);
    window.addEventListener("resize", follow);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", follow);
      void nativeView.hide().catch(() => undefined);
    };
  }, [open]);
  useEffect(() => {
    const node = body.current;
    if (!url || !node) return;
    setProblem("");
    void nativeView.show(url, boundsOf(node)).catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
  }, [url]);
  // Full width hides the conversation; closing the panel brings it back.
  useEffect(() => {
    document.documentElement.classList.toggle("artifact-full", open && full);
    return () => document.documentElement.classList.remove("artifact-full");
  }, [open, full]);

  if (!url) return null;
  const id = (ARTIFACT_URL.exec(url)?.[1] ?? "").slice(0, 8);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width, live: width };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The edge is on the left, so dragging left widens the panel.
    drag.current.live = clampArtifactWidth(drag.current.width + drag.current.x - event.clientX, viewport);
    setLive(drag.current.live);
  };
  const end = () => {
    if (!drag.current) return;
    setArtifactWidth(drag.current.live);
    drag.current = null;
    setLive(null);
  };
  return (
    <aside aria-label={t("Artifact")} className={`artifact-panel ${full ? "artifact-panel-full" : ""}`} style={full ? undefined : { width }}>
      {!full && (
        <div
          aria-label={t("Resize the artifact panel")}
          aria-orientation="vertical"
          className="artifact-panel-resize"
          onDoubleClick={() => setArtifactWidth(ARTIFACT_WIDTH.initial)}
          onLostPointerCapture={end}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          role="separator"
          title={t("Drag to resize; double-click for the usual width")}
        />
      )}
      <header className="artifact-panel-head">
        <IconSpark size={14} />
        <span className="artifact-panel-title">{t("Artifact")}</span>
        <span className="artifact-panel-id mono">{id}</span>
        <span className="artifact-panel-space" />
        <button className="button small" onClick={() => setArtifactFull(!full)} type="button">
          {full ? t("Side by side") : t("Full width")}
        </button>
        <button aria-label={t("Open in your browser")} className="icon-button" onClick={() => void openUrl(url)} title={t("Open in your browser")} type="button">
          <IconExternal size={15} />
        </button>
        <button aria-label={t("Close the artifact")} className="icon-button" onClick={closeArtifact} title={t("Close the artifact")} type="button">
          <IconX size={15} />
        </button>
      </header>
      <div className="artifact-panel-body" ref={body}>
        {problem ? <p role="alert">{t(problem)}</p> : <p className="muted small">{t("Loading the artifact…")}</p>}
      </div>
    </aside>
  );
}
