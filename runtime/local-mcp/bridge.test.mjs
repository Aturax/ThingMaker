import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = await readFile(new URL("../agents/local-mcp-bridge.cjs", import.meta.url), "utf8");
const cwd = process.env.THINGMAKER_LOCAL_MCP_DIR || fileURLToPath(new URL(".", import.meta.url));

async function start(t, launch) {
  const child = spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe","pipe","inherit"], windowsHide:true });
  const closed = once(child, "close");
  t.after(async () => { child.stdin.end(); await closed; });
  const ready = once(createInterface({input:child.stdout}), "line");
  child.stdin.write(JSON.stringify(launch) + "\n");
  return JSON.parse((await ready)[0]);
}

test("the bridge publishes isolated loopback endpoints for selected stdio servers", {timeout:15000}, async t => {
  const entries = await start(t, { launcher:process.execPath, workspace:cwd, environment:{}, servers:[{command:"one"},{command:"two"}] });
  assert.equal(entries.length, 2);
  assert.equal(new URL(entries[0].url).hostname, "127.0.0.1");
  assert.notEqual(entries[0].headers.Authorization, entries[1].headers.Authorization);
  assert.equal((await fetch(entries[0].url, {method:"POST"})).status,403);
});

const launcher = process.env.THINGMAKER_LOCAL_TEST_DESKTOP;
test("an authenticated tool call reaches a stdio server inside the AppContainer", {
  skip: process.platform !== "win32" || !launcher, timeout:30000
}, async t => {
  const workspace = await mkdtemp(join(process.env.LOCALAPPDATA, "Packages/ThingMaker.LocalModels/AC/bridge-"));
  try {
    const node = join(workspace,"node.exe");
    await copyFile(process.execPath,node);
    const echo = [
      "const lines=require('node:readline').createInterface({input:process.stdin});",
      "lines.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;",
      "const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:",
      "{content:[{type:'text',text:'fixture replied'}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});"
    ].join("");
    const [entry] = await start(t,{launcher,workspace,environment:{},servers:[{command:node,args:["-e",echo]}]});
    const headers = {...entry.headers,"Content-Type":"application/json","Accept":"application/json, text/event-stream"};
    const post = (id,method,params) => fetch(entry.url,{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
    const init = await post(1,"initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}});
    assert.equal(init.status,200);
    assert.match(await init.text(),/fixture/);
    headers["mcp-session-id"] = init.headers.get("mcp-session-id");
    const call = await post(2,"tools/call",{name:"echo",arguments:{}});
    assert.equal(call.status,200);
    assert.match(await call.text(),/fixture replied/);
    await fetch(entry.url,{method:"DELETE",headers});
  } finally {
    await rm(workspace,{force:true,recursive:true,maxRetries:6,retryDelay:250});
  }
});
