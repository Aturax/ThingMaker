import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

test("AppContainer child receives stdin EOF and flushes stdout before execFile's callback", {
  skip: process.platform !== "win32" || !process.env.THINGMAKER_WEB_TEST_DESKTOP,
}, async () => {
  const work = await mkdtemp(join(process.env.LOCALAPPDATA, "Packages/ThingMaker.LocalModels/AC/stdio-"));
  const node = join(work, "node.exe");
  try {
    await copyFile(process.execPath, node);
    const preload = await readFile(new URL("./windows-local-stdio.mjs", import.meta.url));
    const echo = "process.stdin.pipe(process.stdout)";
    const script = [
      "const {execFile}=require('node:child_process');",
      "const input='x'.repeat(96000);",
      "for(let i=0;i<3;i++){",
      "const child=execFile(process.execPath,['-e',"+JSON.stringify(echo)+"],(err,out)=>{",
      "if(err) throw err; if(out!==input) throw Error('Lost output');console.log('ok');});",
      "child.stdin.end(input);}",
    ].join("\n");
    const { stdout } = await promisify(execFile)(process.env.THINGMAKER_WEB_TEST_DESKTOP, [
      "--thingmaker-appcontainer",node,"--import","data:text/javascript;base64,"+preload.toString("base64"),"-e",script
    ], { cwd: work, windowsHide: true, timeout: 20000 });
    assert.deepEqual(stdout.trim().split(/\s+/), ["ok","ok","ok"]);
  } finally {
    await unlink(node);
    await rmdir(work);
  }
});
