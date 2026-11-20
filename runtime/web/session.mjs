// One process belongs to one attached session. MCP is reachable over loopback;
// shared-tab frames and human input use the desktop's inherited pipes.
import { createServer } from "node:http";
import { access, copyFile, link, mkdir, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { operateLentDocument } from "./lent-document.mjs";
import { browserProxy, fetchDocument, httpUrl, publicAddress } from "./public-network.mjs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const root = process.env.THINGMAKER_WEB_MCP_DIR || fileURLToPath(new URL(".", import.meta.url));
const dep = createRequire(resolve(root, "package.json"));
const { McpServer } = dep("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = dep("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = dep("zod");
const { chromium } = dep("playwright-core");
const results = new Map();
let resultSequence = 0;
const token = randomUUID();
let enabled = process.env.THINGMAKER_WEB_ENABLED === "1";
let browser, launching, context, page;

let revision = 0;
// Moves when the page itself changes under the person: another page or site,
// a closed tab, a lent tab, or an agent action. Every kind of input must
// match it, so typing never lands on a page the person was not looking at.
let navigation = 0;
let lastDocumentState;
// Count the changes that move what a screenshot click would hit: elements
// added or removed (a dialog, new controls), scrolling and resizing. Text,
// attribute and focus changes are left out: live timestamps, carousels and
// spinners change those constantly, and every click would be refused.
function trackDocument() {
  let changed = 0;
  const bump = () => { changed++; };
  new MutationObserver(bump).observe(document, {subtree:true, childList:true});
  for (const type of ["scroll", "resize"]) {
    window.addEventListener(type, bump, true);
  }
  Object.defineProperty(window, "__thingmakerFrameRevision", { get: () => changed });
}

async function currentRevision() {
  const current = page;
  if (current && !current.isClosed()) {
    // The top document only: ad and widget frames change on their own, and
    // one detaching mid-check must not break input.
    const state = JSON.stringify(await current.mainFrame().evaluate(() => window.__thingmakerFrameRevision).catch(() => null));
    if (state !== lastDocumentState) {
      lastDocumentState = state;
      revision++;
    }
  }
  return revision;
}

function serialQueue() {
  let previous = Promise.resolve();
  return work => {
    const result = previous.then(work);
    previous = result.catch(() => {});
    return result;
  };
}
const ordered = serialQueue();
const research = serialQueue();
let proxy;
async function newContext() {
  if (!browser?.isConnected()) {
    launching ??= (async () => {
      proxy ??= await browserProxy();
      return chromium.launch({ headless:true, proxy,
        args:["--force-webrtc-ip-handling-policy=disable_non_proxied_udp","--disable-quic"] });
    })().finally(() => { launching = undefined; });
    browser = await launching;
  }
  const next = await browser.newContext({ viewport: { width: 960, height: 720 }, acceptDownloads: false, serviceWorkers:"block" });
  next.setDefaultTimeout(5000);
  await next.route("**/*", async route => {
    try { await publicAddress(new URL(httpUrl(route.request().url())).hostname); }
    catch { return route.abort(); }
    return route.continue();
  });
  return next;
}
async function withResearchPage(work) {
  const isolated = await newContext();
  try { return await work(await isolated.newPage()); }
  finally { await isolated.close(); }
}
async function open(target) {
  const url = httpUrl(target);
  if (!context || !context.browser()?.isConnected()) {
    context = await newContext();
    await context.addInitScript(trackDocument);
    context.on("page", next => {
      page = next;
      revision++; navigation++;
      next.on("framenavigated", (navigated) => { if (page === next && navigated === next.mainFrame()) { revision++; navigation++; } });
      next.on("close", () => { if (page === next) page = context.pages().at(-1); revision++; navigation++; });
    });
  }
  if (!page || page.isClosed()) page = await context.newPage();
  if (page.url() !== url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 18000 });
}
async function describe() {
  if (!page) return "There is no open page. Use web_open.";
  return page.url() + "\n" + (await page.locator("body").ariaSnapshot({ timeout: 5000 })).slice(0, 24000);
}

function searchUrl(query, site, lang, freshness) {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", site ? "site:"+site+" "+query : query);
  if (lang) url.searchParams.set("setlang", lang);
  const range = { day: "ez1", week: "ez2", month: "ez3", year: "ez5" }[freshness];
  if (range) url.searchParams.set("filters", 'ex1:"'+range+'"');
  return url.href;
}
async function browserSearch(source, {query, site, lang, freshness, max_results = 8}) {
  const inlineSite = query.match(/(?:^|\s)site:([\w.-]+)/i)?.[1];
  site = (site || inlineSite)?.toLowerCase();
  // Use a domain-aware index for site searches. Both providers expose normal results pages.
  const scoped = site && !freshness;
  const url = scoped ? new URL("https://search.seznam.cz/") : new URL(searchUrl(query, inlineSite ? undefined : site, lang, freshness));
  if (scoped) url.searchParams.set("q", inlineSite ? query : "site:"+site+" "+query);
  await source.goto(url.href, { waitUntil: "domcontentloaded", timeout: 18000 });
  const links = source.locator(scoped ? 'h3 a[data-e-a="heading"]' : "#b_results .b_algo h2 a");
  await links.first().waitFor({ timeout: 5000 }).catch(() => {});
  const candidates = await links.evaluateAll(anchors => anchors.map(link => ({
    title: link.textContent?.trim(), url: link.href, snippet: link.closest("li")?.querySelector("p")?.innerText || ""
  })));
  const output = [];
  for (const item of candidates) {
    if (!item.title || !item.url) continue;
    const link = new URL(item.url);
    const encoded = link.searchParams.get("u");
    if (link.hostname.endsWith(".bing.com") && link.pathname === "/ck/a" && encoded?.startsWith("a1")) {
      item.url = Buffer.from(encoded.slice(2), "base64url").toString("utf8");
    }
    let url;
    try { url = new URL(httpUrl(item.url)); } catch { continue; }
    if (site && url.hostname !== site && !url.hostname.endsWith("."+site)) continue;
    const id = "r"+(++resultSequence);
    results.set(id, url.href);
    if (results.size > 200) results.delete(results.keys().next().value);
    output.push(id+". "+item.title+"\n"+url.href+"\n"+item.snippet.slice(0,400));
    if (output.length >= max_results) break;
  }
  return output.join("\n\n") || "No matching results could be extracted.";
}

async function readPdf(url) {
  const response = await fetchDocument(url);
  if (!response.ok) throw Error("Could not read PDF: HTTP "+response.status);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) throw Error("PDF exceeds 16 MiB");
    chunks.push(chunk);
  }
  const pdf = await dep("pdf-parse/lib/pdf-parse.js")(Buffer.concat(chunks), { max: 80 });
  return response.url+"\n"+pdf.text.slice(0,24000);
}
const storeUrl = "https://chromewebstore.google.com/detail/browse/mfnicocicmmlkpjnaffgihfjhdgjkdjg";
const exec = promisify(execFile);
let chromeTab, chromeDetached = false, browseClient;
async function browseBinary() {
  // Browse ships one native companion per system and processor.
  const windows = process.platform === "win32";
  const pkg = "@opencode/browse-"+(windows ? "windows" : process.platform)+"-"+process.arch;
  const name = windows ? "browse.exe" : "browse";
  const source = resolve(root, "node_modules", pkg, "bin", name);
  const cache = process.env.THINGMAKER_BROWSE_BIN_DIR;
  if (!cache) return source;
  // Multiple chats can use the same relay. Keep its running image outside the
  // installation directory while a desktop update replaces it. A universal
  // Mac holds one copy per processor.
  const directory = resolve(cache, dep(pkg+"/package.json").version, ...(windows ? [] : [process.arch]));
  const binary = resolve(directory, name);
  try { await access(binary); return binary; }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  await mkdir(directory, {recursive:true});
  const temporary = resolve(directory, randomUUID()+".tmp");
  try {
    await copyFile(source, temporary);
    try { await link(temporary, binary); }
    catch (e) { if (e.code !== "EEXIST") throw e; }
  } finally { await unlink(temporary).catch(e => { if (e.code !== "ENOENT") throw e; }); }
  return binary;
}
const browseEnv = { ...process.env, OPENCODE_BROWSER_AUTO_UPDATE:"off" };
async function browseTool(name, args = {}) {
  if (!browseClient) {
    const { Client } = dep("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = dep("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({name:"ThingMaker",version:"1"});
    await client.connect(new StdioClientTransport({command:await browseBinary(), args:["mcp"], env:browseEnv, stderr:"inherit"}));
    client.onclose = () => { if (browseClient === client) browseClient = undefined; };
    browseClient = client;
  }
  const result = await browseClient.callTool({name, arguments:args});
  const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  if (result.isError) throw Error(text);
  return text;
}
async function lentTabs() {
  const status = JSON.parse(await browseTool("status"));
  return status.tabs.filter(tab => tab.lent && tab.browser && tab.targetId).map(tab => ({
    key:JSON.stringify([tab.browser, tab.targetId]), id:tab.tab, url:tab.url, title:tab.title,
  }));
}
function sameOrigin(value, origin) {
  try { return new URL(httpUrl(value)).origin === origin; }
  catch { return false; }
}
async function requireLentTab() {
  const current = (await lentTabs()).find(t => t.key === chromeTab.key && t.id === chromeTab.id);
  if (!current || !sameOrigin(current.url, chromeTab.origin)) {
    chromeDetached = true;
    chromeTab = undefined;
    throw Error("Chrome tab disconnected. Lend it again and choose it in ThingMaker.");
  }
  chromeTab = {...current, origin:chromeTab.origin};
  return current.id;
}
async function chromeCommand(command) {
  const tab = await requireLentTab();
  const origin = chromeTab.origin;
  if (command.kind === "open" && !sameOrigin(command.url, origin)) {
    throw Error("To use another site, lend its tab in ThingMaker.");
  }
  // Browse's Playwright-style actions and snapshots can span documents. Bind
  // each read or edit to the document that checks the origin in the same task.
  async function run(command) {
    let result;
    try {
      const raw = await browseTool("eval", {tab, world:"isolated", expression:"(_, args) => (" + operateLentDocument.toString() + ")(args)",
        arg:{origin, command},timeout:12000});
      result = JSON.parse(raw);
    } catch {
      throw Error("Chrome action could not be completed on the shared site.");
    }
    if (result.disconnected) {
      chromeDetached = true;
      chromeTab = undefined;
      throw Error("Chrome tab disconnected. Lend it again and choose it in ThingMaker.");
    }
    if (result.refused || typeof result.text !== "string") throw Error("Chrome action could not be completed on the shared site.");
    return result.text;
  }
  const result = await run(command);
  await requireLentTab();
  return command.kind === "act" ? run({kind:"page"}) : result;
}
async function browsePair() {
  // With a zero wait Browse prints a valid code and exits 1 (not yet redeemed).
  let output;
  try { output = (await exec(await browseBinary(),["pair","--wait-seconds","0"],{env:browseEnv,windowsHide:true,timeout:20000})).stdout; }
  catch (e) { if (e.code !== 1) throw e; output = e.stdout; }
  const code = output?.match(/Pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1];
  if (!code) throw Error("OpenCode Browse could not generate a pairing code.");
  return { ...await frame(), pairingCode:code, relayAddress:output.match(/localhost:\d+/)?.[0] || "localhost:19988" };
}
async function frame() {
  if (chromeTab || chromeDetached) return { storeUrl, enabled, revision, navigation, activity:"", choices:[], image:null,
    url:chromeTab?.url || "", chrome:chromeTab ? "connected" : "disconnected" };
  const visible = page && !page.isClosed();
  // Stamp before sampling: a change during capture must invalidate this frame.
  const capturedRevision = await currentRevision();
  const image = visible ? (await page.screenshot({ type: "jpeg", quality: 65, caret: "initial", timeout: 5000 })).toString("base64") : null;
  const choices = visible ? await page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLSelectElement ? Array.from(el.options, opt => ({ label: opt.label, value: opt.value, selected: opt.selected })) : [];
  }) : [];
  return { storeUrl, enabled, activity: "", revision: capturedRevision, navigation, url: visible ? page.url() : "", image, choices };
}
function makeServer() {
  const server = new McpServer({ name: "thingmaker-web", version: "1.0.0" });
  function tool(name, description, inputSchema, run, schedule = ordered) {
    server.registerTool(name, { description, inputSchema }, args => schedule(async () => {
      if (!enabled) throw Error("Web is private. The user can enable access in the Web tab.");
      if (schedule === ordered && chromeDetached) throw Error("Chrome tab disconnected. Reconnect in the Web tab.");
      const result = await run(args);
      return { content: typeof result === "string" ? [{ type: "text", text: result }] : result };
    }));
  }
  const searchSchema = {
    query: z.string().min(1), site: z.string().optional(), lang: z.string().optional(),
    freshness: z.enum(["day","week","month","year"]).optional(), max_results: z.number().int().min(1).max(20).optional(),
  };
  tool("web_search", "Search for sources independently of the shared tab. Verify time-sensitive facts with web_read. If results are unrelated, read a known authoritative URL or public data API directly.", searchSchema,
    args => withResearchPage(source => browserSearch(source, args)), research);
  const target = { url: z.string().optional(), result_id: z.string().optional() };
  function urlFor(args) {
    const url = args.result_id ? results.get(args.result_id) : args.url;
    if (!url) throw Error("Supply a URL or a current search result_id");
    return httpUrl(url);
  }
  const readTarget = {
    ...target,
    screenshot: z.boolean().optional().describe("Return a viewport image for charts, diagrams or other visual content."),
    scroll_y: z.number().int().nonnegative().optional().describe("Vertical offset in CSS pixels for a screenshot below the fold."),
  };
  tool("web_read", "Read a source URL or search result in isolation, including public JSON APIs. For a weather forecast, you can read api.open-meteo.com/v1/forecast using latitude, longitude, daily=precipitation_probability_max and the local timezone. Check the returned dates. Request a screenshot when text is insufficient.", readTarget, async args => {
    const url = urlFor(args);
    if (args.scroll_y !== undefined && !args.screenshot) throw Error("scroll_y requires screenshot");
    if (/\.pdf(?:$|[?#])/i.test(url)) {
      if (args.screenshot) throw Error("Screenshots are available for web pages. Read this PDF as text.");
      return readPdf(url);
    }
    const result = await withResearchPage(async source => {
      await source.goto(url, { waitUntil: "domcontentloaded", timeout: 18000 });
      // Give client-rendered pages time to fetch their content, even when
      // they initially display a loading label. Long-polling sites are bounded.
      await source.waitForLoadState("networkidle", { timeout: 3500 }).catch(() => {});
      if (args.screenshot) {
        if (args.scroll_y) await source.evaluate(y => window.scrollTo({ top: y, behavior: "instant" }), args.scroll_y);
        const image = await source.screenshot({ type: "png", timeout: 5000 });
        return [
          { type: "text", text: source.url() },
          { type: "image", mimeType: "image/png", data: image.toString("base64") },
        ];
      }
      await source.waitForFunction(() => document.body?.innerText.trim(), null, { timeout: 3000 }).catch(() => {});
      const body = (await source.locator("body").innerText()).trim();
      return body && source.url()+"\n"+body.slice(0, 24000);
    });
    if (result) return result;
    throw Error("No readable text on this page. Try web_read with screenshot enabled.");
  }, research);
  tool("web_open", "Navigate the shared Web tab. Supply a URL or search result_id.", target, async args => {
    if (chromeTab) return chromeCommand({kind:"open", url:urlFor(args)});
    await open(urlFor(args)); return describe();
  });
  tool("web_page", "Inspect the current shared page, including the user's latest changes.", {}, async () => {
    return chromeTab ? chromeCommand({kind:"page"}) : describe();
  });
  tool("web_act", "Interact with a visible element. For Browse, use the ref in the latest web_page (for example a3). Alternatively supply the exact accessibility role and complete name. For select, use role combobox, its name, and the option label as value.", {
    action: z.enum(["click","fill","select","press"]), ref: z.string().regex(/^(?:f[0-9]+)?[ae][0-9]+$/).optional(), role: z.string().optional(), name: z.string().optional(), value: z.string().optional()
  }, async ({ action, ref, role, name, value }) => {
    if (action === "select" && value === undefined) throw Error('Selection did not run. Pass the field label as name and the desired option label as value.');
    if (action !== "click" && value === undefined) throw Error("A value is required");
    if (!(chromeTab && ref) && (!role || name === undefined)) throw Error("Supply the exact role and name from web_page.");
    if (chromeTab) return chromeCommand({kind:"act", action, ref, role, name, value});
    if (!page) throw Error("Open a page first");
    // The agent can change a form property without a DOM mutation. Invalidate
    // before dispatch so even a partially applied action invalidates stale input.
    revision++; navigation++;
    const element = page.getByRole(role, { name, exact: true });
    if (action === "click") await element.click();
    else if (action === "fill") await element.fill(value);
    else if (action === "select") await element.selectOption({ label: value });
    else await element.press(value);
    return describe();
  });
  return server;
}
// Generate discovery metadata from the same SDK registrations used to run the tools.
if (process.argv.includes("--print-tool-catalog")) {
  const { Client } = dep("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = dep("@modelcontextprotocol/sdk/inMemory.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = makeServer();
  const client = new Client({name:"packager",version:"1"});
  await server.connect(serverSide);
  await client.connect(clientSide);
  console.log(JSON.stringify(await client.listTools()));
  await client.close();
  await server.close();
  process.exit(0);
}

const http = createServer(async (req, res) => {
  if (req.headers.origin || req.headers.authorization !== "Bearer "+token || req.url !== "/mcp") {
    res.writeHead(403).end(); return;
  }
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  const server = makeServer();
  res.on("close", () => server.close().catch(() => {}));
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
function reply(value) { process.stdout.write(JSON.stringify(value)+"\n"); }
http.listen(0, "127.0.0.1", () => reply({ port: http.address().port, token }));
async function desktop(cmd) {
  if (cmd.kind === "pair" && enabled && !chromeTab) return browsePair();
  if (cmd.kind === "listBrowse" && enabled) return {...await frame(), lentTabs:await lentTabs()};
  if (cmd.kind === "attachBrowse" && enabled && !chromeTab) {
    const tab = (await lentTabs()).find(t => t.key === cmd.key);
    if (!tab) throw Error("Lend the tab using the Browse toolbar button first.");
    const url = new URL(httpUrl(tab.url));
    if (!sameOrigin(cmd.url, url.origin)) throw Error("The tab changed sites. Refresh the list and choose it again.");
    await publicAddress(url.hostname);
    chromeTab = {...tab, origin:url.origin};
    chromeDetached = false;
    revision++; navigation++;
    return frame();
  }
  if (cmd.kind === "unshare") {
    chromeTab = undefined;
    chromeDetached = false;
    return frame();
  }
  if (chromeTab || chromeDetached) {
    if (cmd.kind !== "frame") throw Error("Use Chrome to interact with the shared tab.");
    if (chromeTab) await requireLentTab().catch(() => {});
    return frame();
  }
  if (cmd.kind === "enable") enabled = true;
  else if (cmd.kind !== "frame") {
    if (!enabled) throw Error("Web access is disabled");
    if (cmd.kind === "open") await open(cmd.url);
    else if (cmd.kind === "search") await open(searchUrl(cmd.query));
    else {
      if (!page) throw Error("Page changed. Try again on the current frame.");
      // Any input must be for the page the person saw: after a navigation,
      // typed text would otherwise land on another page or site.
      if (cmd.navigation !== navigation) throw Error("Page changed. Try again on the current frame.");
      // A click lands where the frame showed something, so it must be the
      // frame the person saw. Keys, text and a menu choice go to what has
      // focus, and typing changes the page itself, so small changes to the
      // page don't refuse them.
      if ((cmd.kind === "click" || cmd.kind === "scroll") && cmd.revision !== await currentRevision()) throw Error("Page changed. Try again on the current frame.");
      if (cmd.kind === "click") await page.mouse.click(cmd.x, cmd.y);
      else if (cmd.kind === "scroll") { await page.mouse.move(cmd.x, cmd.y); await page.mouse.wheel(0,cmd.dy); }
      else if (cmd.kind === "key") await page.keyboard.press(cmd.key);
      else if (cmd.kind === "text") await page.keyboard.insertText(cmd.text);
      else if (cmd.kind === "select") await page.locator("select:focus").selectOption(cmd.value);
      else throw Error("Unknown browser action");
    }
  }
  return frame();
}
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const { id, action } = JSON.parse(line);
  ordered(() => desktop(action)).then(value => reply({ id, value }), error => reply({ id, error: error.message }));
});
lines.on("close", async () => { http.close(); await browseClient?.close().catch(() => {}); await browser?.close().catch(() => {}); process.exit(0); });
