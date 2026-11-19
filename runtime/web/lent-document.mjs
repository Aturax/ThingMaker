/** Executed synchronously in Browse's isolated world in the top-level document. */
export function operateLentDocument({origin, command}) {
  if (location.origin !== origin) return {disconnected:true};
  if (command.kind === "open") {
    if (new URL(command.url).origin !== origin) return {refused:true};
    location.assign(command.url);
    return {text:"Navigation requested."};
  }

  const elements = Array.from(document.querySelectorAll(
    'a[href],button,input:not([type=hidden]),textarea,select,[role="button"],[role="link"],[role="textbox"],[role="combobox"]'
  )).filter(el => el.checkVisibility({visibilityProperty:true}));
  const roleOf = el => el.getAttribute("role") || (el.matches("a") ? "link" : el.matches("select") ? "combobox" :
    el.matches("button,input[type=submit],input[type=button]") ? "button" : el.matches("input[type=checkbox]") ? "checkbox" : "textbox");
  const nameOf = el => el.getAttribute("aria-label") ||
    (el.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ").trim() ||
    Array.from(el.labels || [], label => Array.from(label.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent).join("")).join(" ").trim() ||
    (el.matches("button,a,[role=button],[role=link]") ? el.innerText.trim() : el.placeholder || el.title || "");
  // Weak keys live in the isolated JS world. A detached document loses its refs.
  const refs = globalThis.thingMakerLentRefs ??= {ids:new WeakMap(), next:crypto.getRandomValues(new Uint32Array(1))[0]};
  function refOf(el) {
    if (!refs.ids.has(el)) refs.ids.set(el, "e"+(++refs.next));
    return refs.ids.get(el);
  }
  if (command.kind === "act") {
    const matches = elements.filter(el => command.ref ? refOf(el) === command.ref : roleOf(el) === command.role && nameOf(el) === command.name);
    if (matches.length !== 1 || matches[0].matches(":disabled")) return {refused:true};
    const el = matches[0];
    if (command.action === "select" && el instanceof HTMLSelectElement) {
      const opt = Array.from(el.options).find(opt => opt.label === command.value && !opt.disabled);
      if (!opt) return {refused:true};
      el.selectedIndex = opt.index;
      el.dispatchEvent(new Event("input", {bubbles:true}));
      el.dispatchEvent(new Event("change", {bubbles:true}));
    } else if (command.action === "fill" && el.matches("textarea,input:not([type=file]):not([type=submit]):not([type=button])") && !el.readOnly) {
      el.value = command.value;
      el.dispatchEvent(new Event("input", {bubbles:true}));
      el.dispatchEvent(new Event("change", {bubbles:true}));
    } else if (command.action === "click" || (command.action === "press" && ["Enter","Space"].includes(command.value))) {
      // The user handles links that open another site or browsing context.
      const link = el.closest("a[href]");
      if (link && (link.origin !== origin || (link.target && link.target !== "_self"))) return {refused:true};
      if (el.form && (new URL(el.formAction || el.form.action).origin !== origin || (el.form.target && el.form.target !== "_self"))) return {refused:true};
      el.click();
    } else return {refused:true};
    return {text:"Action completed."};
  }
  const controls = elements.slice(0,180).map(el => {
    const selected = el instanceof HTMLSelectElement ? Array.from(el.options, opt => opt.label + (opt.selected ? " [selected]" : "")).join(", ") : "";
    return refOf(el)+" "+roleOf(el)+" "+JSON.stringify(nameOf(el))+(selected ? " ("+selected+")" : "");
  });
  return {text:(controls.join("\n")+"\n"+document.body.innerText.slice(0,18000)).slice(0,24000)};
}
