import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexClient } from "./codex-client.js";

let dir: string;
const clients: CodexClient[] = [];
beforeEach(() => {
  const cache = path.join(os.homedir(), ".cache/autocrew-yt/tests");
  fs.mkdirSync(cache, { recursive: true }); dir = fs.mkdtempSync(path.join(cache, "codex-client-"));
});
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); fs.rmSync(dir, { recursive: true, force: true }); });
function client(script: string, options: { requestTimeoutMs?: number; maxMessageBytes?: number } = {}) {
  const file = path.join(dir, `fake-${clients.length}.mjs`);
  fs.writeFileSync(file, `import readline from "node:readline";\nconst lines=readline.createInterface({input:process.stdin});\n${script}`);
  const child = new CodexClient({ command: process.execPath, args: [file], cwd: dir, requestTimeoutMs: 1500, closeGraceMs: 30, ...options });
  clients.push(child); return child;
}

describe("Codex JSONL transport using isolated child processes", () => {
  it("correlates out-of-order replies and decodes split UTF-8 without mixing requests", async () => {
    const rpc = client(`let first;
lines.on("line",line=>{const m=JSON.parse(line);if(!first){first=m;return;}
process.stdout.write(JSON.stringify({id:m.id,result:{order:2}})+"\\n");
const b=Buffer.from(JSON.stringify({id:first.id,result:{text:"中文回复"}})+"\\n");
const at=b.indexOf(Buffer.from("中"))+1;process.stdout.write(b.subarray(0,at));setTimeout(()=>process.stdout.write(b.subarray(at)),5);});`);
    const [one, two] = await Promise.all([rpc.request("one"), rpc.request("two")]);
    expect(one).toEqual({ text: "中文回复" }); expect(two).toEqual({ order: 2 });
  });

  it("times out one request and ignores its late ACK without corrupting a later response", async () => {
    const rpc = client(`lines.on("line",line=>{const m=JSON.parse(line);setTimeout(()=>process.stdout.write(JSON.stringify({id:m.id,result:{method:m.method}})+"\\n"),m.method==="slow"?500:0);});`, { requestTimeoutMs: 250 });
    await expect(rpc.request("slow")).rejects.toMatchObject({ code: "request_timeout" });
    expect(await rpc.request("fast")).toEqual({ method: "fast" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await rpc.request("last")).toEqual({ method: "last" });
  });

  it("rejects malformed protocol data without exposing stderr or wire payloads", async () => {
    const rpc = client(`lines.on("line",()=>{process.stderr.write("secret-key-never-display");process.stdout.write("secret-key-never-display\\n");});`);
    const error = await rpc.request("broken").catch((e) => e);
    expect(error.code).toBe("protocol_invalid");
    expect(error.message).not.toContain("secret-key-never-display");
    expect(rpc.closed).toBe(true);
  });

  it("bounds incomplete lines and does not wait forever for a newline", async () => {
    const rpc = client(`lines.on("line",()=>process.stdout.write("x".repeat(5000)));`, { maxMessageBytes: 1000 });
    await expect(rpc.request("huge")).rejects.toMatchObject({ code: "protocol_invalid" });
  });

  it("handles server requests on their own ID instead of confusing them with client ACKs", async () => {
    const rpc = client(`let asked;
lines.on("line",line=>{const m=JSON.parse(line);if(m.method){asked=m;process.stdout.write(JSON.stringify({id:"server-1",method:"approval",params:{}})+"\\n");}
else if(m.id==="server-1")process.stdout.write(JSON.stringify({id:asked.id,result:{decision:m.result.decision}})+"\\n");});`);
    rpc.onServerRequest((message) => rpc.reply(message.id, { decision: "decline" }));
    expect(await rpc.request("job")).toEqual({ decision: "decline" });
  });

  it("cleans its own process even when EOF and SIGTERM are ignored", async () => {
    const rpc = client(`process.on("SIGTERM",()=>{});setInterval(()=>{},1000);
lines.on("line",line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({id:m.id,result:{pid:process.pid}})+"\\n");});`);
    const { pid } = await rpc.request("pid");
    await rpc.close();
    expect(() => process.kill(pid as number, 0)).toThrow();
    await expect(rpc.request("after-close")).rejects.toMatchObject({ code: "transport_closed" });
  });
});
