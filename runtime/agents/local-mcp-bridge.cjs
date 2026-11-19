// Windows MCP stdio needs pipes created outside the AppContainer. The host
// translates the transport only. Its child is always the sandbox launcher.
const { createServer } = require("node:http");
const { randomUUID } = require("node:crypto");
const { createInterface } = require("node:readline");
const { existsSync } = require("node:fs");
const { basename, delimiter, dirname, isAbsolute, join, resolve } = require("node:path");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

function sandboxCommand(spec, environment) {
  const env = { ...environment, ...spec.env };
  // Node otherwise walks inaccessible drive ancestors while resolving even
  // explicitly granted files. Child Node processes inherit these flags.
  env.NODE_OPTIONS = [env.NODE_OPTIONS, "--preserve-symlinks --preserve-symlinks-main"].filter(Boolean).join(" ");
  const args = spec.args ?? [];
  const npm = /^(npm|npx)(?:\.cmd)?$/i.exec(basename(spec.command));
  if (npm) {
    // CreateProcess takes an executable. Use npm's JS entry point directly
    // so server arguments never pass through a command shell.
    const path = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
    const roots = isAbsolute(spec.command) ? [dirname(spec.command)] : path.split(delimiter).filter(isAbsolute);
    for (const root of roots) {
      const cli = join(root, "node_modules", "npm", "bin", npm[1].toLowerCase() + "-cli.js");
      if (existsSync(cli)) return { command: existsSync(join(root, "node.exe")) ? join(root, "node.exe") : "node.exe", args: [cli, ...args], env };
    }
  }
  return { command: spec.command, args, env };
}

const input = createInterface({ input: process.stdin });
const children = new Set();
input.once("close", () => {
  Promise.allSettled([...children].map(child => child.close())).finally(() => process.exit());
});
input.once("line", line => {
  const { launcher, workspace, servers, environment } = JSON.parse(line);
  const entries = servers.map(spec => ({ spec, token: randomUUID(), sessions: new Map() }));
  const listener = createServer(async (req, res) => {
    const entry = entries.find(item => req.headers.authorization === "Bearer " + item.token);
    if (!entry || req.url !== "/mcp") return res.writeHead(403).end();
    const id = req.headers["mcp-session-id"];
    let http = entry.sessions.get(id);
    try {
      if (!http) {
        if (id || req.method !== "POST") return res.writeHead(404).end();
        const { command, args, env } = sandboxCommand(entry.spec, environment);
        const child = new StdioClientTransport({
          command: launcher, args: ["--thingmaker-appcontainer", command, ...(args ?? [])],
          cwd: resolve(workspace, entry.spec.cwd || "."), env,
        });
        http = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID, onsessioninitialized: key => entry.sessions.set(key, http),
        });
        http.onmessage = message => child.send(message).catch(() => http.close());
        child.onmessage = message => http.send(message).catch(() => http.close());
        http.onclose = () => { entry.sessions.delete(http.sessionId); void child.close(); };
        child.onclose = () => { children.delete(child); void http.close(); };
        res.once("finish", () => { if (!http.sessionId) void child.close(); });
        children.add(child);
        try { await child.start(); await http.start(); }
        catch (error) { children.delete(child); await child.close(); throw error; }
      }
      await http.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  listener.listen(0, "127.0.0.1", () => console.log(JSON.stringify(entries.map(entry => ({
    type: "http", url: "http://127.0.0.1:" + listener.address().port + "/mcp",
    headers: { Authorization: "Bearer " + entry.token },
  })))));
});
