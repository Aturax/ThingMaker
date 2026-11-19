/**
 * The Temporary switch of a quick chat, and the line that says what it does.
 *
 * A temporary chat is deleted, with its folder and its transcripts on this
 * computer, when ThingMaker quits. Nothing can tell Claude or OpenAI to treat
 * the conversation differently on their side, so the note says so rather
 * than promise an incognito mode it cannot give.
 */
import { useStore } from "../store";
import { t } from "../i18n";
import { IconTemporaryChat } from "./icons";

export function TemporaryChatButton({ workspaceId }: { workspaceId: string }) {
  const quick = useStore((s) => s.quickChats.find((chat) => chat.workspaceId === workspaceId));
  const setTemporary = useStore((s) => s.setQuickChatTemporary);
  if (!quick) return null;
  const label = quick.temporary ? t("Temporary chat: on") : t("Temporary chat");
  return (
    <button
      aria-label={label}
      aria-pressed={quick.temporary}
      className={`temporary-chat-button ${quick.temporary ? "on" : ""}`}
      data-tip={t("Temporary chat")}
      onClick={() => void setTemporary(workspaceId, !quick.temporary)}
      title={quick.temporary ? t("Temporary: deleted when ThingMaker quits. Click to keep it.") : t("Make this a temporary chat: deleted when ThingMaker quits")}
      type="button"
    >
      <IconTemporaryChat size={17} />
    </button>
  );
}

/** Shown while a quick chat is temporary. */
export function TemporaryChatNote({ workspaceId, local }: { workspaceId: string; local?: boolean }) {
  const temporary = useStore((s) => s.quickChats.some((chat) => chat.workspaceId === workspaceId && chat.temporary));
  if (!temporary) return null;
  return (
    <p className="temporary-chat-note">
      <IconTemporaryChat size={14} />
      <span>
        <strong>{t("Temporary chat")}</strong>{" "}
        {local
          ? t("Deleted from this computer when ThingMaker quits. It runs on this computer only.")
          : t("Deleted from this computer when ThingMaker quits. Your provider still handles it under your account's settings.")}
      </span>
    </p>
  );
}
