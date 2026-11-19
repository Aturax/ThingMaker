import { lookup } from "node:dns/promises";
import { createServer, request } from "node:http";
import { connect, isIP } from "node:net";
import { randomUUID } from "node:crypto";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";

export function httpUrl(target) {
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw Error("Use a public HTTP or HTTPS URL without credentials.");
  }
  return url.href;
}

export async function publicAddress(host, resolveHost = lookup) {
  const hostname = host.replace(/^\[|\]$/g, "");
  if (process.env.THINGMAKER_WEB_TEST_LOOPBACK === "1" && hostname === "127.0.0.1") return hostname;
  const addresses = isIP(hostname) ? [{address:hostname}] : await resolveHost(hostname, {all:true});
  if (!addresses.length || addresses.some(({address}) => {
    const ip = ipaddr.parse(address);
    return ip.range() !== "unicast" || (ip.kind() === "ipv6" && !ip.match(ipaddr.parse("2000::"), 3));
  })) throw Error("Web access is limited to public internet addresses.");
  return addresses[0].address;
}

// Both the PDF client and Chromium connect to the exact address we checked.
const dispatcher = new Agent({connect:{lookup(host, options, callback) {
  publicAddress(host).then(address => options.all
    ? callback(null, [{address, family:isIP(address)}])
    : callback(null, address, isIP(address)), callback);
}}});

export async function fetchDocument(target) {
  let url = new URL(httpUrl(target));
  const signal = AbortSignal.timeout(20000);
  for (let i = 0; i <= 10; i++) {
    // Literal addresses bypass the HTTP client's DNS callback.
    await publicAddress(url.hostname);
    const response = await fetch(url, {dispatcher, redirect:"manual", signal});
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) throw Error("Redirect missing its destination");
    url = new URL(httpUrl(new URL(location, url)));
  }
  throw Error("Too many redirects");
}

export async function browserProxy() {
  const password = randomUUID();
  const authorization = "Basic " + Buffer.from("browser:" + password).toString("base64");
  const proxy = createServer(async (req, res) => {
    if (req.headers["proxy-authorization"] !== authorization) {
      res.writeHead(407, {"Proxy-Authenticate":'Basic realm="ThingMaker"'}).end();
      return;
    }
    try {
      const url = new URL(httpUrl(req.url));
      if (url.protocol !== "http:") throw Error("HTTPS requires a tunnel");
      const headers = {...req.headers, host:url.host};
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const address = await publicAddress(url.hostname);
      const remote = request({hostname:address, port:url.port || 80, method:req.method, path:url.pathname + url.search, headers}, upstream => {
        res.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(res);
      });
      remote.on("error", () => res.destroy());
      res.on("close", () => remote.destroy());
      req.pipe(remote);
    } catch { res.writeHead(403).end(); }
  });
  proxy.on("connect", async (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    if (req.headers["proxy-authorization"] !== authorization) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="ThingMaker"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    try {
      const url = new URL(httpUrl("https://" + req.url));
      const address = await publicAddress(url.hostname);
      if (socket.destroyed) return;
      const remote = connect(Number(url.port || 443), address);
      socket.on("close", () => remote.destroy());
      remote.on("error", () => socket.destroy());
      remote.on("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        socket.pipe(remote).pipe(socket);
      });
    } catch { socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); }
  });
  await new Promise((resolve,reject) => proxy.once("error",reject).listen(0, "127.0.0.1", resolve));
  return {server:"http://127.0.0.1:"+proxy.address().port, username:"browser", password, bypass:"<-loopback>"};
}
