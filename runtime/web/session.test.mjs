import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("user and agent interact with the same live page without switching control", { timeout: 60000 }, async () => {
  let releaseMutation, mutationObserved;
  const mutate = new Promise(resolve => { releaseMutation = resolve; });
  const mutated = new Promise(resolve => { mutationObserved = resolve; });
  const site = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === "/dynamic") {
      res.end(`<input autofocus id="before"><script>
        fetch("/release").then(() => {
          document.body.innerHTML = '<input id="after">';
          document.getElementById("after").focus();
          fetch("/mutated");
        });
      </script>`);
      return;
    }
    if (req.url === "/release") { mutate.then(() => res.end("ok")); return; }
    if (req.url === "/mutated") { mutationObserved(); res.end("ok"); return; }
    if (req.url === "/chart") {
      res.end(`<body style="margin:0">Quarterly totals<div style="height:900px"></div>
        <canvas width="500" height="240"></canvas>
        <script>const ctx = document.querySelector("canvas").getContext("2d");
        [60, 180, 90].forEach((h, i) => ctx.fillRect(40 + 100*i, 200-h, 70, h));</script></body>`);
      return;
    }
    if (req.url === "/source") {
      res.end(`<body>Loading<script>
        fetch("/reference").then(r => r.text()).then(code => {
          document.body.textContent = code + " " + (localStorage.getItem("draft") || "isolated");
        });
      </script></body>`);
      return;
    }
    if (req.url === "/reference") {
      setTimeout(() => res.end("TM-431"), 200);
      return;
    }
    res.end('<script>localStorage.setItem("draft","private")</script><label>Category<select onchange="document.querySelector(\'button\').textContent=this.value"><option>All</option><option>Books</option></select></label><button onclick="this.textContent+=\' opened\'">All</button>');
  });
  site.listen(0,"127.0.0.1");
  await once(site,"listening");
  const child = spawn(process.execPath,[fileURLToPath(new URL("./session.mjs",import.meta.url))], {
    env:{ ...process.env, THINGMAKER_WEB_ENABLED:"0", THINGMAKER_WEB_TEST_LOOPBACK:"1", WEB_SCOUT_ENV_FILE:"none", WEB_SCOUT_LLM_PROVIDER:"none" }, windowsHide:true
  });
  child.stderr.pipe(process.stderr);
  const lines = createInterface({ input:child.stdout })[Symbol.asyncIterator]();
  let seq = 0;
  try {
    const { port, token } = JSON.parse((await lines.next()).value);
    const rpc = async (method, params) => {
      const resp = await fetch("http://127.0.0.1:"+port+"/mcp", { method:"POST",
        headers: { Authorization:"Bearer "+token, "Content-Type":"application/json", Accept:"application/json, text/event-stream" },
        body:JSON.stringify({jsonrpc:"2.0",id:++seq,method,params})
      });
      assert.equal(resp.status,200);
      const json = await resp.json();
      assert.ok(!json.error,JSON.stringify(json.error)); return json.result;
    };
    const call = (name,args={}) => rpc("tools/call",{name,arguments:args});
    const rawUi = async action => {
      child.stdin.write(JSON.stringify({id:++seq,action})+"\n");
      return JSON.parse((await lines.next()).value);
    };
    const ui = async action => {
      const reply = await rawUi(action);
      assert.ok(!reply.error,reply.error); return reply.value;
    };
    assert.ok((await rpc("tools/list",{})).tools.some(t => t.name === "web_search"));
    const url = "http://127.0.0.1:"+site.address().port;
    assert.ok((await call("web_open",{url})).isError);
    assert.ok((await call("web_read",{url:url+"/source"})).isError);
    await ui({kind:"enable"});
    assert.match((await call("web_open",{url})).content[0].text,/Category/);
    let frame = await ui({kind:"frame"});
    assert.ok(frame.image);
    frame = await ui({kind:"key",key:"Tab",revision:frame.revision});
    assert.equal(frame.choices[1].label,"Books");
    frame = await ui({kind:"select",value:"Books",revision:frame.revision});
    const source = await call("web_read",{url:url+"/source"});
    assert.equal(source.content[0].text,url+"/source\nTM-431 isolated");
    const chart = url+"/chart";
    const textOnly = await call("web_read", {url:chart});
    assert.deepEqual(textOnly.content, [{type:"text", text:chart+"\nQuarterly totals"}]);
    const capture = async scroll_y => {
      const result = await call("web_read", {url:chart, screenshot:true, scroll_y});
      assert.equal(result.content[0].text, chart);
      const image = result.content[1];
      assert.equal(image.type, "image");
      assert.equal(image.mimeType, "image/png");
      const png = Buffer.from(image.data, "base64");
      assert.equal(png.subarray(1,4).toString(), "PNG");
      assert.equal(png.readUInt32BE(16), 960);
      assert.equal(png.readUInt32BE(20), 720);
      return image.data;
    };
    assert.notEqual(await capture(0), await capture(900));
    const after = await ui({kind:"frame"});
    assert.equal(after.url,frame.url);
    assert.equal(after.revision,frame.revision);
    const action = {action:"click",role:"button",name:"Books"};
    assert.match((await call("web_page")).content[0].text,/button "Books"/);
    assert.match((await call("web_act",action)).content[0].text,/Books opened/);
    const stale = await rawUi({kind:"click",x:10,y:10,revision:after.revision});
    assert.match(stale.error,/Page changed/);
    const current = await ui({kind:"frame"});
    assert.notEqual(current.revision,after.revision);
    await ui({kind:"key",key:"Tab",revision:current.revision});
    assert.equal(after.storeUrl, "https://chromewebstore.google.com/detail/browse/mfnicocicmmlkpjnaffgihfjhdgjkdjg");
    const before = await ui({kind:"open",url:url+"/dynamic"});
    releaseMutation();
    await mutated;
    const staleText = await rawUi({kind:"text",text:"stale",revision:before.revision});
    assert.match(staleText.error,/Page changed/);
    const fresh = await ui({kind:"frame"});
    await ui({kind:"text",text:"fresh",revision:fresh.revision});
    assert.match((await call("web_page")).content[0].text,/fresh/);
  } finally { releaseMutation(); child.stdin.end(); site.close(); }
});
