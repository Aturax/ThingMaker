// Invoke with the INSTALLED web-runtime/node.exe, passing the installed runtime
// directory. Optional CDP URL targets an already-running installed desktop.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [root, cdp] = process.argv.slice(2);
const dep = createRequire(join(root, "package.json"));
const site = createServer((_req, res) => {
  res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
  res.end('<label>Category<select onchange="document.querySelector(\'button\').textContent=this.value"><option>All</option><option>Books</option></select></label><button onclick="this.textContent+=\' opened\'">All</button>');
});
site.listen(0,"127.0.0.1");
await once(site,"listening");
const fixture = "http://127.0.0.1:"+site.address().port+"/";
const env = {...process.env, PATH: process.env.SystemRoot+"\\System32", THINGMAKER_WEB_PORTABLE:"1", THINGMAKER_WEB_ENABLED:"1", PLAYWRIGHT_BROWSERS_PATH:join(root,"browsers")};
delete env.THINGMAKER_WEB_MCP_DIR;
delete env.WEB_SCOUT_SEARXNG_URL;
const child = spawn(process.execPath,[join(root,"session.mjs")],{cwd:root,env,windowsHide:true});
child.stderr.pipe(process.stderr);
const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
const evidence = {};
let browser;
try {
  const {port,token} = JSON.parse((await lines.next()).value);
  let seq = 0;
  async function call(name,args={}) {
    const r = await fetch("http://127.0.0.1:"+port+"/mcp", {
      method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json",Accept:"application/json, text/event-stream"},
      body:JSON.stringify({jsonrpc:"2.0",id:++seq,method:"tools/call",params:{name,arguments:args}}),
      signal:AbortSignal.timeout(90000)
    });
    assert.equal(r.status,200);
    const {result,error} = await r.json();
    assert.ok(!error,JSON.stringify(error));
    return result;
  }
  async function ui(action) {
    child.stdin.write(JSON.stringify({id:++seq,action})+"\n");
    const reply=JSON.parse((await lines.next()).value);
    assert.ok(!reply.error, reply.error);
    return reply.value;
  }
  assert.ok((await call("web_open",{url:fixture})).content[0].text.includes("Category"));
  await call("web_act",{action:"select",role:"combobox",name:"Category",value:"Books"});
  const before = await ui({kind:"frame"});
  const search = await call("web_search",{query:"Playwright BrowserContext documentation",site:"playwright.dev"});
  assert.ok(!search.isError,search.content[0].text);
  const text = search.content[0].text;
  const official = text.split("\n\n").find(row=>/\nhttps:\/\/(?:www\.)?playwright\.dev\//i.test(row));
  assert.ok(official,"Expected a Playwright result: "+text.slice(0,500));
  const id = official.match(/^r\d+/)[0];
  const read = await call("web_read",{result_id:id});
  assert.ok(!read.isError,read.content[0].text);
  assert.match(read.content[0].text,/Playwright/);
  evidence.source = read.content[0].text.split("\n")[0];
  assert.equal(new URL(evidence.source).hostname,"playwright.dev");
  const after = await ui({kind:"frame"});
  assert.equal(after.url,before.url);
  assert.equal(after.revision,before.revision);
  assert.match((await call("web_page")).content[0].text,/button "Books"/);
  await call("web_act",{action:"select",role:"combobox",name:"Category",value:"All"});
  let frame=await ui({kind:"frame"});
  assert.ok(frame.image);
  const action={action:"click",role:"button",name:"Books"};
  frame=await ui({kind:"key",key:"Tab",revision:frame.revision});
  assert.ok(frame.choices.some(c=>c.value==="Books"));
  await ui({kind:"select",value:"Books",revision:frame.revision});
  assert.match((await call("web_page")).content[0].text,/button "Books"/);
  assert.match((await call("web_act",action)).content[0].text,/Books opened/);
  evidence.handoff="Books opened";
  console.log("MCP and shared Chromium passed", evidence);
  if(cdp) {
    const end=Date.now()+180000;
    while(!browser && Date.now()<end) {
      try {browser=await dep("playwright-core").chromium.connectOverCDP(cdp,{timeout:5000});}
      catch {await new Promise(r=>setTimeout(r,1000));}
    }
    assert.ok(browser,"Installed desktop WebView did not start");
    const tab=browser.contexts()[0].pages()[0];
    tab.setDefaultTimeout(90000);
    const skip=tab.getByRole("button",{name:/skip for now|omitir por ahora|saltar por ahora/i});
    const launch=tab.getByRole("button",{name:/open web browser|abrir navegador web/i});
    await skip.or(launch).first().waitFor();
    if(await skip.isVisible()) await skip.click();
    await launch.click();
    const address=tab.getByRole("textbox",{name:/search or enter a URL|busca o introduce una URL/i});
    await address.fill("Playwright BrowserContext documentation");
    await address.press("Enter");
    const panel=tab.locator(".office-web");
    await panel.getByText(/https:\/\/www\.bing\.com\/search/).waitFor();
    const picture=panel.locator("img.web-frame");
    await picture.waitFor();
    assert.ok((await picture.getAttribute("src")).length>1000);
    await address.fill(fixture);
    await address.press("Enter");
    await panel.getByText(fixture,{exact:true}).waitFor();
    await picture.focus();
    await picture.press("Tab");
    const select=panel.getByRole("combobox");
    await select.selectOption("Books");
    await tab.waitForFunction(()=>document.querySelector(".office-web select")?.value==="Books");
    evidence.desktop="Search, navigation, live frame and filter in the installed ThingMaker window";
    console.log(evidence.desktop);
  }
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  child.stdin.end();
  site.close();
}
