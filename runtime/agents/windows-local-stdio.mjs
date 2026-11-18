// Node/libuv creates anonymous child stdio in the global Windows pipe namespace.
// Inside an AppContainer that can hang before the child even starts. Allocate
// equivalent private pipe pairs in the supported LOCAL namespace instead.
// Loaded only by ThingMaker's sandboxed Windows Claude ACP adapter.
import cp from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";

const spawn = cp.ChildProcess.prototype.spawn;
function pipePair(input) {
  const path = "\\\\.\\pipe\\LOCAL\\thingmaker-" + randomUUID();
  const stream = new PassThrough();
  let drained;
  const finished = new Promise(resolve => { drained = resolve; });
  stream.once("close", drained);
  const server = createServer(socket => {
    server.close();
    if (stream.destroyed) { socket.destroy(); return; }
    socket.once("close", drained);
    socket.on("error", error => stream.destroy(error));
    stream.on("close", () => {
      // For stdin, end() may already have queued more bytes than fit in the
      // pipe. Let socket.end() flush them before the child receives EOF.
      if (!input || !stream.readableEnded) socket.destroy();
    });
    if (input) stream.pipe(socket);
    else socket.pipe(stream);
  });
  server.listen(path);
  try {
    return { fd: openSync(path, "r+"), server, stream, finished };
  } catch (error) {
    server.close();
    throw error;
  }
}

cp.ChildProcess.prototype.spawn = function (options) {
  const spec = options.stdio ?? "pipe";
  if (typeof spec === "string" && !["pipe", "overlapped"].includes(spec)) {
    return spawn.call(this, options);
  }
  const stdio = Array.isArray(spec) ? [...spec] : [spec, spec, spec];
  while (stdio.length < 3) stdio.push(null);
  const pairs = new Map();
  try {
    for (let i = 0; i < 3; i++) {
      if (stdio[i] == null || stdio[i] === "pipe" || stdio[i] === "overlapped") {
        const pair = pipePair(i === 0);
        pairs.set(i, pair);
        stdio[i] = pair.fd;
      }
    }
    const child = this;
    const result = spawn.call(child, { ...options, stdio });
    // Node waits for its own output pipes before emitting close. Since it
    // received file descriptors here, preserve that ordering ourselves.
    const outputs = [...pairs].filter(([i]) => i !== 0).map(([, p]) => p.finished);
    if (outputs.length) {
      const emit = child.emit;
      child.emit = function (event, ...args) {
        if (event !== "close") return emit.call(this, event, ...args);
        this.emit = emit;
        Promise.all(outputs).then(() => emit.call(this, event, ...args));
        return true;
      };
    }
    for (const [index, pair] of pairs) {
      child.stdio[index] = pair.stream;
      child[["stdin","stdout","stderr"][index]] = pair.stream;
    }
    child.once("error", () => {
      for (const pair of pairs.values()) { pair.stream.destroy(); pair.server.close(); }
    });
    return result;
  } catch (error) {
    for (const pair of pairs.values()) { pair.stream.destroy(); pair.server.close(); }
    throw error;
  } finally {
    for (const pair of pairs.values()) closeSync(pair.fd);
  }
};
