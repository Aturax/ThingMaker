import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { operateLentDocument } from "./lent-document.mjs";

test("a loan only reads and acts in the approved top-level document", async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({contentType:"text/html", body:
      '<label>Category<select><option>All</option><option>Books</option></select></label><button>Open</button>'}));
    const origin = "https://approved.test";
    await page.goto(origin);
    const run = command => page.evaluate(operateLentDocument, {origin,command});
    assert.match((await run({kind:"page"})).text, /combobox "Category"/);
    assert.ok((await run({kind:"act",action:"select",role:"combobox",name:"Category",value:"Books"})).text);
    assert.equal(await page.getByLabel("Category").inputValue(), "Books");
    await page.goto("https://other.test");
    assert.deepEqual(await run({kind:"page"}), {disconnected:true});
    assert.deepEqual(await run({kind:"act",action:"select",role:"combobox",name:"Category",value:"Books"}), {disconnected:true});
    assert.equal(await page.getByLabel("Category").inputValue(), "All");
  } finally { await browser.close(); }
});
