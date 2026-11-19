import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { SessionHandle, WebAction, WebFrame } from "@thingmaker/contracts";
import { api } from "../ipc";
import { t } from "../i18n";

export function WebView({ handle, standalone = false }: { handle: SessionHandle; standalone?: boolean }) {
  const [frame, setFrame] = useState<WebFrame | null>(null);
  const [error, setError] = useState("");
  const [storeError, setStoreError] = useState("");
  const [code, setCode] = useState("");
  const [relay, setRelay] = useState("");
  const [tabs, setTabs] = useState<WebFrame["lentTabs"]>();
  const [url, setUrl] = useState("");
  const alive = useRef(false);
  const pending = useRef(0);
  const sequence = useRef(0);

  async function request(action: WebAction) {
    const id = ++sequence.current;
    pending.current++;
    try {
      const next = await api.webControl(handle, action);
      if (alive.current && id === sequence.current) {
        setFrame(next);
        if (next.pairingCode) { setCode(next.pairingCode); setRelay(next.relayAddress || ""); }
        if (next.lentTabs) setTabs(next.lentTabs);
        if (action.kind === "attachBrowse" || action.kind === "unshare") setTabs(undefined);
        if (next.chrome === "connected" || action.kind === "unshare") setCode("");
        if (action.kind !== "frame") setError("");
      }
      return true;
    } catch (cause) {
      if (alive.current && id === sequence.current) setError((cause as Error).message);
      return false;
    } finally { pending.current--; }
  }
  useEffect(() => {
    setCode(""); setTabs(undefined);
    let stopped = false;
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      let ok = true;
      if (!document.hidden && !pending.current) ok = await request({ kind: "frame" });
      if (!stopped) timer = setTimeout(() => void refresh(), ok ? 700 : 5000);
    }
    void refresh();
    return () => { stopped = true; alive.current = false; clearTimeout(timer); };
  }, [handle.id, handle.attachmentGeneration]);

  function point(event: MouseEvent<HTMLImageElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * 960 / rect.width, y: (event.clientY - rect.top) * 720 / rect.height };
  }
  return <section className="office-web">
    {error && <p role="alert">{t(error)}</p>}
    {storeError && <p role="alert">{storeError}</p>}
    {frame && !standalone && frame.chrome !== "connected" && <div>
      <button className="button small" disabled={!frame.storeUrl} onClick={() => {
        if (frame.storeUrl) void api.openExternal(frame.storeUrl).catch(e => setStoreError(String(e)));
      }}>{t("Add to Chrome")}</button>
      {!frame.storeUrl && <span className="small"> {t("Chrome Web Store listing pending")}</span>}
    </div>}
    {frame && <>
      {!frame.enabled ? <button className="button" onClick={() => void request({ kind: "enable" })}>{t("Allow web access for this local session")}</button> : <>
        {!standalone && frame.chrome !== "connected" && <>
          <button className="button small" onClick={() => void request({kind:"pair"})}>{t("Pair OpenCode Browse")}</button>
          {code && <label>{t("In Browse options, open Advanced and connect with this address and code")} <span>{relay}</span> <input readOnly value={code} onFocus={e => e.target.select()} /></label>}
          <p>{t("Click Browse on the Chrome tab you want to lend, then choose it here.")}</p>
          <button className="button small" onClick={() => void request({kind:"listBrowse"})}>{t("Show lent tabs")}</button>
          {tabs?.length === 0 && <p>{t("No lent tabs found.")}</p>}
          {tabs?.map(tab => <button className="button small" key={tab.key} onClick={() => void request({kind:"attachBrowse",key:tab.key})}>{tab.title} · {tab.url}</button>)}
        </>}
        {frame.chrome && <>
          <p role="status">{t(frame.chrome === "disconnected" ? "Chrome tab disconnected" : "Chrome tab shared")}</p>
          <button className="button small" onClick={() => void request({kind:"unshare"})}>{t("Return to built-in browser")}</button>
        </>}
        {!frame.chrome && <form onSubmit={event => {
          event.preventDefault();
          const value = url.trim();
          if (value) void request(/^https?:\/\//i.test(value) ? { kind: "open", url: value } : { kind: "search", query: value });
        }}>
          <input aria-label={t("Search or enter a URL")} placeholder={t("Search or enter a URL")} value={url} onChange={event => setUrl(event.target.value)} required />
          <button className="button small" type="submit">{t("Open")}</button>
        </form>}
        <p className="small" dir="auto">{frame.url || frame.activity || t("Waiting for a web page")}</p>
        {frame.image && <img className="web-frame" src={"data:image/jpeg;base64," + frame.image} alt={t("Shared browser page")}
          tabIndex={0}
          onClick={event => { event.currentTarget.focus(); void request({ kind: "click", revision: frame.revision, ...point(event) }); }}
          onWheel={event => { if (!pending.current) void request({ kind: "scroll", revision: frame.revision, ...point(event), dy: event.deltaY }); }}
          onPaste={event => { event.preventDefault(); void request({ kind: "text", revision: frame.revision, text: event.clipboardData.getData("text") }); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
            if (event.key === "Escape") { event.currentTarget.blur(); return; }
            if (event.key.length === 1) {
              event.preventDefault(); void request({ kind: "text", revision: frame.revision, text: event.key });
            } else if (["Enter","Backspace","Delete","Tab","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"].includes(event.key)) {
              event.preventDefault(); void request({ kind: "key", revision: frame.revision, key: (event.shiftKey ? "Shift+" : "") + event.key });
            }
          }} />}
        {!!frame.choices.length && <select aria-label={t("Page options")} value={frame.choices.find(item => item.selected)?.value} onChange={event => void request({ kind: "select", revision: frame.revision, value: event.target.value })}>
          {frame.choices.map((item,i) => <option value={item.value} key={i}>{item.label}</option>)}
        </select>}
      </>}
    </>}
  </section>;
}

export function BrowserLauncher() {
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState<SessionHandle | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let session: SessionHandle | undefined;
    const close = (h: SessionHandle) => { void api.webControl(h, { kind: "close" }).catch(() => {}); };
    void api.webBrowserOpen().then(h => {
      if (disposed) close(h);
      else { session = h; setHandle(h); }
    }).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; if (session) close(session); };
  }, [open]);
  return <section>
    <button className="button" type="button" aria-expanded={open} onClick={() => { setHandle(null); setError(""); setOpen(!open); }}>
      {t(open ? "Close web browser" : "Open web browser")}
    </button>
    {open && (handle ? <WebView handle={handle} standalone /> : <p role="status">{error || t("Connecting…")}</p>)}
  </section>;
}
