import assert from "node:assert/strict";
import test from "node:test";
import { fetchDocument, publicAddress } from "./public-network.mjs";

test("allows public addresses only when every resolved address is public", async () => {
  const dns = (...addresses) => async () => addresses.map(address => ({address}));
  assert.equal(await publicAddress("example.test", dns("93.184.216.34")), "93.184.216.34");
  for (const address of ["127.0.0.1","10.0.0.1","172.16.0.1","192.168.1.1","169.254.1.1","100.64.0.1",
      "0.0.0.0","224.0.0.1","::1","::","fd00::1","fe80::1","::ffff:192.168.1.1","64:ff9b::1"]) {
    await assert.rejects(publicAddress(address), /public internet/);
    await assert.rejects(publicAddress("example.test", dns("93.184.216.34", address)), /public internet/);
  }
  await assert.rejects(fetchDocument("http://127.0.0.1/document.pdf"), /public internet/);
});

test("PDF redirects validate the destination before fetching it", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push(url.href);
    assert.equal(options.redirect, "manual");
    return new Response(null, {status:302, headers:{location:"http://192.0.2.1/fixture.pdf"}});
  });
  await assert.rejects(fetchDocument("https://93.184.216.34/fixture.pdf"), /public internet/);
  assert.deepEqual(requests, ["https://93.184.216.34/fixture.pdf"]);
});
