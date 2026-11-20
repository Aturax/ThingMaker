/**
 * The claude.ai artifacts this conversation published, opened or linked,
 * latest first. A row opens the artifact in the panel beside the
 * conversation (in the browser on the phone, which has no panel).
 */
import { useMemo } from "react";
import { openArtifact, opensInPanel, useArtifactView } from "../artifactView";
import { t } from "../i18n";
import { sessionArtifacts, type SessionArtifact } from "../sessionArtifacts";
import { useStore } from "../store";
import { IconExternal, IconSpark } from "./icons";

function actionWords(artifact: SessionArtifact): string {
  const updates = artifact.publishes - (artifact.action === "created" ? 1 : 0);
  switch (artifact.action) {
    case "created":
      return updates === 0 ? t("Created here") : updates === 1 ? t("Created here, updated once") : t("Created here, updated {n} times", { n: updates });
    case "updated":
      return artifact.publishes === 1 ? t("Updated here") : t("Updated here {n} times", { n: artifact.publishes });
    case "opened":
      return t("Opened here");
    case "linked":
      return t("Linked in the conversation");
  }
}

export function ArtifactsPane({ sessionId }: { sessionId: string }) {
  const projection = useStore((s) => s.sessions[sessionId]?.projection);
  const openUrl = useStore((s) => s.openUrl);
  const shown = useArtifactView().url;
  const artifacts = useMemo(() => (projection ? sessionArtifacts(projection) : []), [projection]);

  const open = (url: string) => {
    if (opensInPanel(url)) openArtifact(url);
    else void openUrl(url);
  };

  return (
    <div className="artifacts-pane">
      {artifacts.length === 0 ? (
        <div className="artifacts-empty">
          <IconSpark size={18} />
          <p>{t("No artifacts in this conversation yet.")}</p>
          <p className="small muted">{t("Pages and documents the agent publishes on claude.ai, opens, or links to appear here.")}</p>
        </div>
      ) : (
        <>
          <p className="small muted">
            {artifacts.length === 1 ? t("{n} artifact in this conversation", { n: 1 }) : t("{n} artifacts in this conversation", { n: artifacts.length })}
          </p>
          <ul className="artifacts-list">
            {artifacts.map((artifact) => {
              const on = shown !== null && shown.includes(artifact.id);
              return (
                <li className={`artifacts-row ${on ? "artifacts-row-on" : ""}`} key={artifact.id}>
                  <button className="artifacts-open" onClick={() => open(artifact.url)} title={t("Open {url}", { url: artifact.url })} type="button">
                    <IconSpark size={15} />
                    <span className="artifacts-text">
                      <span className="artifacts-title">{artifact.title ?? t("Artifact")}</span>
                      <span className="small muted">
                        {actionWords(artifact)} · <span className="mono">{artifact.id.slice(0, 8)}</span>
                        {on ? ` · ${t("on show")}` : ""}
                      </span>
                    </span>
                  </button>
                  <button aria-label={t("Open in your browser")} className="icon-button" onClick={() => void openUrl(artifact.url)} title={t("Open in your browser")} type="button">
                    <IconExternal size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
