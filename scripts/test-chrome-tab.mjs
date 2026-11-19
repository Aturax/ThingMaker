// Driven through stdin/stdout by the live desktop-agent test in commands/web.rs.
// THINGMAKER_TEST_BROWSE_EXTENSION is the unpacked v0.1.5 release ZIP, with the
// public/manifest.json development key from the upstream v0.1.5 tag added.
// This preserves the release scripts and lets the relay recognize the unpacked ID.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {createInterface} from "node:readline";
import {once} from "node:events";

const runtime = resolve("apps/desktop/dist-web");
const {chromium} = createRequire(runtime+"/package.json")("playwright-core");
const extension = resolve(process.env.THINGMAKER_TEST_BROWSE_EXTENSION || "output/browse-upstream/chrome");
const site = createServer((req,res) => {
  res.setHeader("Content-Type","text/html; charset=utf-8");
  if (req.url === "/start") res.end('<a href="/catalog">Open catalog</a>');
  else if (req.url === "/catalog") res.end(`<label>Category<select><option>All</option><option>Books</option><option>Games</option></select></label>
    <button>Open All</button><p></p><script>
    const select = document.querySelector("select"), button = document.querySelector("button");
    select.onchange = () => button.textContent = "Open "+select.value;
    button.onclick = () => document.querySelector("p").textContent = select.value+" opened";
    </script>`);
  else res.end('<label>Private draft<input></label>');
});
site.listen(0,"127.0.0.1");
await once(site,"listening");
const origin = "http://127.0.0.1:"+site.address().port;
const lines = createInterface({input:process.stdin})[Symbol.asyncIterator]();
const ctx = await chromium.launchPersistentContext("",{
  channel:"chromium", headless:false, args:["--enable-unsafe-extension-debugging","--disable-extensions-except="+extension,"--load-extension="+extension],
  timeout:20000,
});
ctx.setDefaultTimeout(30000);
try {
  const [other] = ctx.pages();
  await other.goto(origin+"/other");
  await other.getByLabel("Private draft").fill("untouched");
  const tab = await ctx.newPage();
  await tab.goto(origin+"/catalog");
  const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const options = await ctx.newPage();
  await options.goto("chrome-extension://"+extensionId+"/settings.html");
  await options.locator("summary").click();
  const {code,relay,server} = JSON.parse((await lines.next()).value);
  await options.getByPlaceholder("localhost:19988").fill(relay);
  await options.getByPlaceholder("XXXX-XXXX").fill(code);
  await options.getByRole("button",{name:"Connect",exact:true}).click();
  const ui = async action => {
    console.log(JSON.stringify(action));
    return JSON.parse((await lines.next()).value);
  };
  await options.getByRole("heading",{name:"Connected to the relay on this computer",exact:true}).waitFor();
  await tab.bringToFront();
  const chrome = await ctx.browser().newBrowserCDPSession();
  const {targetInfos} = await chrome.send("Target.getTargets",{filter:[{type:"tab"}]});
  const target = targetInfos.find(t => t.url === tab.url());
  assert.ok(target, JSON.stringify(targetInfos.map(t=>[t.type,t.url])));
  await chrome.send("Extensions.triggerAction",{id:extensionId,targetId:target.targetId});
  let lent;
  for (let i=0;i<40 && !lent;i++) {
    lent = (await ui({kind:"listBrowse"})).lentTabs.find(t=>t.url===tab.url());
    if (!lent) await new Promise(r=>setTimeout(r,250));
  }
  assert.ok(lent,"Browse did not lend the selected Chrome tab");
  const attached = await ui({kind:"attachBrowse",key:lent.key});
  assert.ok(attached.chrome==="connected");
  console.log("shared");
  await lines.next();
  await tab.getByRole("button",{name:"Open Books"}).waitFor({timeout:120000});
  console.error("Agent set Books on the lent tab.");
  await tab.getByLabel("Category").selectOption("Games");
  await other.bringToFront();
  console.log("edited");
  await tab.getByText("Games opened",{exact:true}).waitFor({timeout:120000});
  assert.equal(await other.getByLabel("Private draft").inputValue(),"untouched");
  assert.ok(await other.evaluate(()=>document.visibilityState==="visible"),"The other tab must remain in front");
  assert.equal(tab.url(),origin+"/catalog");
  console.error("Same chat opened Games while the other tab remained visible with its draft intact.");
  // A human revokes the loan by pressing the toolbar icon on the lent tab itself.
  await tab.bringToFront();
  await chrome.send("Extensions.triggerAction",{id:extensionId,targetId:target.targetId});
  for (let i=0;i<40;i++) {
    if (!(await ui({kind:"listBrowse"})).lentTabs.some(t=>t.key===lent.key)) break;
    await new Promise(r=>setTimeout(r,100));
  }
  const revoked = await fetch(server.url,{method:"POST",headers:{
    Authorization:server.headers[0].value,"Content-Type":"application/json",Accept:"application/json, text/event-stream"
  },body:JSON.stringify({id:2,jsonrpc:"2.0",method:"tools/call",params:{name:"web_page",arguments:{}}})}).then(r=>r.json());
  assert.equal(revoked.result.isError,true);
  assert.equal((await ui({kind:"frame"})).chrome,"disconnected");
  await ui({kind:"unshare"});
  console.error("Human selected Games; agent resumed and opened Games. Other draft preserved.");
  console.log("Games opened");
} finally { await ctx.close(); site.close(); }
