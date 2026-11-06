import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexAdapter } from "./codex-host.js";
import type { CodexHostAdapter } from "./types.js";

let dir: string;
const adapters: CodexHostAdapter[] = [];
beforeEach(() => {
  const cache = path.join(os.homedir(), ".cache/autocrew-yt/tests");
  fs.mkdirSync(cache, { recursive: true }); dir = fs.mkdtempSync(path.join(cache, "codex-host-"));
});
afterEach(async () => { await Promise.all(adapters.splice(0).map((adapter) => adapter.close())); fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(scenario: Record<string, unknown> = {}, onAttention?: (id: string, reason: string) => void) {
  const trace = path.join(dir, `trace-${adapters.length}.jsonl`), file = path.join(dir, `fake-${adapters.length}.mjs`);
  fs.writeFileSync(trace, "");
  fs.writeFileSync(file, `import fs from "node:fs";import readline from "node:readline";
const s=${JSON.stringify(scenario)}, trace=${JSON.stringify(trace)};
const send=m=>process.stdout.write(JSON.stringify(m)+"\\n");const reply=(m,result)=>send({id:m.id,result});
let cwd="", active=false, approvalParent=null, waiting=0;
const turn=(id="turn-1",status="inProgress")=>({id,status,items:[]});
const complete=()=>{active=false;send({method:"turn/completed",params:{threadId:"thread-1",turn:turn("turn-1",s.failTurn?"failed":"completed")}});};
const ackTurn=m=>{
 if(s.completeBeforeAck){complete();reply(m,{turn:turn()});return;}
 active=true;send({method:"turn/started",params:{threadId:"thread-1",turn:turn()}});reply(m,{turn:turn()});
 if(s.completeDelay!==undefined)setTimeout(complete,s.completeDelay);
 if(s.lateApproval)setTimeout(()=>send({id:"approval-late",method:"item/commandExecution/requestApproval",params:{threadId:"thread-1",command:"PRIVATE-COMMAND"}}),s.lateApproval);
 if(s.authChange)setTimeout(()=>send({method:"account/updated",params:{authMode:"apiKey"}}),20);
};
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);fs.appendFileSync(trace,JSON.stringify(m)+"\\n");
 if(!m.method){if(approvalParent&&--waiting===0){const p=approvalParent;approvalParent=null;ackTurn(p);}return;}
 switch(m.method){
 case "initialize":if(s.globalRequest)send({id:"global-input",method:"account/chatgptAuthTokens/refresh",params:{private:"PRIVATE-TOKEN"}});reply(m,{userAgent:"fake-codex"});break;
 case "initialized":break;
 case "account/read":reply(m,{account:{type:s.account??"chatgpt",email:"PRIVATE-ACCOUNT",planType:"pro"},requiresOpenaiAuth:true});break;
 case "config/read":reply(m,{config:{model_provider:s.provider??"openai",model_providers:s.providerOverrides??{},model:"user-default",approval_policy:"on-request",sandbox_mode:"workspace-write"}});break;
 case "thread/start":cwd=m.params.cwd;if(s.dropCreate){process.exit(0);break;}
  if(s.earlyApproval)send({id:"approval-create",method:"mcpServer/elicitation/request",params:{threadId:"thread-1"}});
  setTimeout(()=>reply(m,{thread:{id:"thread-1",cwd:s.wrongCwd??cwd,status:{type:"idle"}},modelProvider:s.effectiveProvider??"openai"}),s.earlyApproval?10:0);break;
 case "thread/name/set":if(s.nameUnsupported)send({id:m.id,error:{code:-32601,message:"PRIVATE-PAYLOAD"}});else reply(m,{});break;
 case "turn/start":
  if(s.dropTurn){process.exit(0);break;}
  if(s.noTurnAck){active=true;break;}
  if(s.approvals){approvalParent=m;waiting=s.approvals.length;for(const [i,method]of s.approvals.entries())send({id:"approval-"+i,method,params:{threadId:"thread-1",command:"PRIVATE-COMMAND",questions:["PRIVATE-QUESTION"]}});}
  else ackTurn(m);break;
 case "thread/list":{const page=s.pages?.[m.params.cursor??"first"]??{data:[]};reply(m,page);break;}
 case "thread/read":reply(m,{thread:{id:m.params.threadId,cwd:s.savedCwd??cwd??"/source/job",status:{type:s.threadStatus??(active?"active":"idle"),activeFlags:s.flags??[]}}});break;
 case "thread/turns/list":reply(m,s.history?.[m.params.cursor??"first"]??{data:[{id:"old-turn",status:"completed",items:[{type:"userMessage",content:[{type:"text",text:"真实任务 marker"}]},{type:"agentMessage",text:"真实回复"}]}],nextCursor:null});break;
 case "thread/resume":reply(m,{thread:{id:s.resumeId??m.params.threadId},modelProvider:s.effectiveProvider??"openai"});break;
 case "turn/interrupt":active=false;send({method:"turn/completed",params:{threadId:m.params.threadId,turn:turn(m.params.turnId,"interrupted")}});reply(m,{});break;
 default:send({id:m.id,error:{code:-32601,message:"PRIVATE-PAYLOAD"}});
 }
});`);
  const adapter = createCodexAdapter({ client: { command: process.execPath, args: [file], cwd: dir, env: { ...process.env, OPENAI_BASE_URL: "" }, requestTimeoutMs: 1500, closeGraceMs: 50 }, onAttention });
  adapters.push(adapter);
  const requests = () => fs.readFileSync(trace, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const input = { jobId: "job-1", cwd: path.join(dir, "unique-job"), title: "公众号派生", prompt: "本任务 marker=job-1，请接手" };
  return { adapter, input, requests };
}

async function until(check: () => boolean) {
  const end = Date.now() + 1500;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

describe("Codex host adapter with a fake AppServer subprocess", () => {
  it("blocks API authentication and custom providers without creating a thread or changing configuration", async () => {
    for (const scenario of [{ account: "apiKey" }, { provider: "custom-api" }, { providerOverrides: { openai: { base_url: "https://proxy.example", env_key: "PRIVATE-KEY" } } }]) {
      const f = fixture(scenario);
      const capability = await f.adapter.capability();
      expect(capability.ok).toBe(false);
      const result = await f.adapter.start(f.input, async () => { throw new Error("must not create"); });
      expect(result.status).toBe("blocked");
      expect(JSON.stringify(capability)).not.toContain("PRIVATE-");
      expect(f.requests().some((m) => m.method === "thread/start" || m.method.startsWith("config/value"))).toBe(false);
    }
  });

  it("persists the thread before sending a turn and inherits model/provider/approval/sandbox", async () => {
    const f = fixture({ nameUnsupported: true });
    let persisted: string | undefined, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = f.adapter.start(f.input, async (id) => { persisted = id; await gate; });
    await until(() => persisted === "thread-1");
    expect(f.requests().some((m) => m.method === "turn/start")).toBe(false);
    release();
    expect(await started).toMatchObject({ status: "started", session: { threadId: "thread-1", turnId: "turn-1" } });
    const messages = f.requests();
    expect(messages.filter((m) => m.method === "initialize")).toHaveLength(1);
    expect(messages.find((m) => m.method === "account/read").params).toEqual({ refreshToken: false });
    expect(messages.find((m) => m.method === "config/read").params.cwd).toBe(f.input.cwd);
    expect(messages.find((m) => m.method === "thread/start").params).toEqual({ cwd: f.input.cwd, threadSource: "autocrew_derivative_dispatch" });
    expect(messages.find((m) => m.method === "turn/start").params).toEqual({ threadId: "thread-1", input: [{ type: "text", text: f.input.prompt }] });
    expect(f.adapter.activeCount()).toBe(1);
  });

  it("never sends a turn when durable persistence/source recheck fails", async () => {
    const f = fixture();
    const result = await f.adapter.start(f.input, async () => { throw new Error("PRIVATE-CALLBACK-DETAILS"); });
    expect(result).toMatchObject({ status: "unknown", threadId: "thread-1" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE-");
    expect(f.requests().some((m) => m.method === "turn/start")).toBe(false);
  });

  it("runs the final authorization gate after naming and durable identity writes", async () => {
    const f = fixture();
    const binding = path.join(dir, "binding.json"), audit = path.join(dir, "gate-audit.json");
    const result = await f.adapter.start(f.input, async (id) => {
      await fs.promises.writeFile(binding, JSON.stringify({ threadId: id }));
    }, async () => {
      expect(JSON.parse(fs.readFileSync(binding, "utf-8")).threadId).toBe("thread-1");
      expect(f.requests().some((m) => m.method === "thread/name/set")).toBe(true);
      await fs.promises.writeFile(audit, "source changed while naming");
      throw new Error("source changed");
    });
    expect(result).toMatchObject({ status: "blocked", code: "before_turn_blocked", threadId: "thread-1" });
    expect(fs.readFileSync(audit, "utf-8")).toContain("source changed");
    expect(f.requests().some((m) => m.method === "turn/start")).toBe(false);
  });

  it("surfaces unscoped initialization interaction as blocked instead of hiding it", async () => {
    const f = fixture({ globalRequest: true });
    const capability = await f.adapter.capability();
    expect(capability).toMatchObject({ ok: false, reason: expect.stringContaining("需要人工处理") });
    expect(JSON.stringify(capability)).not.toContain("PRIVATE-");
    expect(f.requests().find((m) => m.id === "global-input").error.code).toBe(-32601);
    expect(f.requests().some((m) => m.method === "thread/start")).toBe(false);
  });

  it.each([{ effectiveProvider: "custom-api" }, { wrongCwd: "/other/job" }])("blocks an effective thread configuration mismatch after persisting its identity", async (scenario) => {
    const f = fixture(scenario); let persisted = "";
    const result = await f.adapter.start(f.input, async (id) => { persisted = id; });
    expect(persisted).toBe("thread-1");
    expect(result).toMatchObject({ status: "blocked", code: "effective_config_unverified", threadId: "thread-1" });
    expect(f.requests().some((m) => m.method === "turn/start")).toBe(false);
  });

  it("returns unknown after lost create/turn ACKs and does not retry either operation", async () => {
    for (const scenario of [{ dropCreate: true }, { dropTurn: true }]) {
      const f = fixture(scenario);
      const result = await f.adapter.start(f.input, async () => {});
      expect(result.status).toBe("unknown");
      expect(f.requests().filter((m) => m.method === "thread/start")).toHaveLength(1);
      expect(f.requests().filter((m) => m.method === "turn/start")).toHaveLength(scenario.dropTurn ? 1 : 0);
    }
  });

  it("looks up every exact-cwd page using explicit appServer source filtering", async () => {
    const cwd = path.join(dir, "lookup-job");
    const f = fixture({ pages: { first: { data: [{ id: "thread-a", cwd }, { id: "other", cwd: "/other" }], nextCursor: "page2" }, page2: { data: [{ id: "thread-b", cwd }], nextCursor: null } } });
    expect((await f.adapter.lookup(cwd)).map((thread) => thread.id)).toEqual(["thread-a", "thread-b"]);
    const lists = f.requests().filter((m) => m.method === "thread/list");
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list.params).toMatchObject({ cwd, sourceKinds: ["appServer"] });
    expect(lists[1].params.cursor).toBe("page2");
    expect(f.requests().some((m) => m.method === "thread/start")).toBe(false);
  });

  it("reports incomplete lookup instead of returning an empty result for cyclic cursors", async () => {
    const f = fixture({ pages: { first: { data: [], nextCursor: "again" }, again: { data: [], nextCursor: "again" } } });
    await expect(f.adapter.lookup(f.input.cwd)).rejects.toMatchObject({ code: "lookup_incomplete" });
  });

  it("counts actual start/completion notifications and prevents a stale ACK reviving a completed turn", async () => {
    const f = fixture({ completeDelay: 25 });
    expect(f.adapter.activeCount()).toBe(0);
    await f.adapter.start(f.input, async () => {});
    expect(f.adapter.activeCount()).toBe(1);
    await until(() => f.adapter.activeCount() === 0);
    const race = fixture({ completeBeforeAck: true });
    await race.adapter.start(race.input, async () => {});
    expect(race.adapter.activeCount()).toBe(0);
  });

  it("reserves capacity for pending and unknown turn ACKs until inspect proves idle", async () => {
    const f = fixture({ noTurnAck: true, threadStatus: "idle" });
    const starting = f.adapter.start(f.input, async () => {});
    await until(() => f.requests().some((m) => m.method === "turn/start"));
    expect(f.adapter.activeCount()).toBe(1);
    expect(await f.adapter.resume("thread-1", "原轮次回执尚未返回时不能重发")).toMatchObject({ status: "blocked", code: "thread_active" });
    expect(await starting).toMatchObject({ status: "unknown", code: "turn_start_unknown", threadId: "thread-1" });
    expect(f.adapter.activeCount()).toBe(1);
    await f.adapter.inspect("thread-1");
    expect(f.adapter.activeCount()).toBe(0);
    expect(f.requests().filter((m) => m.method === "turn/start")).toHaveLength(1);
  });

  it("retains unknown capacity when history only contains older completed turns, then releases on close", async () => {
    const f = fixture({ noTurnAck: true, threadStatus: "active" });
    expect((await f.adapter.start(f.input, async () => {})).status).toBe("unknown");
    expect(f.adapter.activeCount()).toBe(1);
    await f.adapter.inspect("thread-1");
    expect(f.adapter.activeCount()).toBe(1);
    await f.adapter.close();
    expect(f.adapter.activeCount()).toBe(0);
  });

  it("declines each interaction schema, reports attention, and survives a throwing callback", async () => {
    const approvals = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "execCommandApproval", "applyPatchApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request", "item/tool/call", "attestation/generate"];
    const attention: string[] = [];
    const f = fixture({ approvals }, (id, reason) => { attention.push(`${id}:${reason}`); throw new Error("consumer failed"); });
    const result = await f.adapter.start(f.input, async () => {});
    expect(result).toMatchObject({ status: "blocked", code: "needs_attention", threadId: "thread-1" });
    expect(attention).toHaveLength(approvals.length);
    expect(attention.join("\n")).not.toContain("PRIVATE-");
    const replies = f.requests().filter((m) => String(m.id).startsWith("approval-"));
    expect(replies).toHaveLength(approvals.length);
    expect(replies[0].result).toEqual({ decision: "decline" });
    expect(replies[1].result).toEqual({ decision: "decline" });
    expect(replies[2].result).toEqual({ permissions: {}, scope: "turn" });
    expect(replies[3].result).toEqual({ decision: "abort" });
    expect(replies[5].result).toEqual({ answers: {} });
    expect(replies[6].result).toEqual({ action: "decline" });
    expect(replies[7].result.success).toBe(false);
    expect(replies[8].error.code).toBe(-32601);
    expect((await f.adapter.inspect("thread-1")).needsAttention).toContain("人工处理");
  });

  it("reports later asynchronous approval/turn errors after the launch ACK", async () => {
    const attention: string[] = [];
    const f = fixture({ lateApproval: 20, completeDelay: 50, failTurn: true }, (_id, reason) => { attention.push(reason); });
    expect((await f.adapter.start(f.input, async () => {})).status).toBe("started");
    await until(() => attention.some((reason) => reason.includes("本轮执行失败")));
    expect(attention.some((reason) => reason.includes("requestApproval"))).toBe(true);
    expect(f.adapter.activeCount()).toBe(0);
  });

  it("preserves creation-time attention and sends no model turn after saving the thread", async () => {
    const f = fixture({ earlyApproval: true }); let persisted = "";
    expect(await f.adapter.start(f.input, async (id) => { persisted = id; })).toMatchObject({ status: "blocked", code: "needs_attention", threadId: "thread-1" });
    expect(persisted).toBe("thread-1");
    expect(f.requests().some((m) => m.method === "turn/start")).toBe(false);
    expect(f.requests().find((m) => m.id === "approval-create").result).toEqual({ action: "decline" });
  });

  it("stops new model input and requests interruption when managed ChatGPT auth changes", async () => {
    const attention: string[] = [];
    const f = fixture({ authChange: true }, (_id, reason) => { attention.push(reason); });
    expect((await f.adapter.start(f.input, async () => {})).status).toBe("started");
    await until(() => f.requests().some((m) => m.method === "turn/interrupt"));
    await until(() => f.adapter.activeCount() === 0);
    expect(attention.some((reason) => reason.includes("登录方式已改变"))).toBe(true);
    expect((await f.adapter.capability()).ok).toBe(false);
    expect(f.requests().filter((m) => m.method === "turn/start")).toHaveLength(1);
  });

  it("reads real bounded paginated history without resuming or exposing command output", async () => {
    const long = "正文".repeat(10_000);
    const f = fixture({ threadStatus: "notLoaded", history: { cursor2: { data: [{ id: "turn-old", status: "inProgress", items: [{ type: "agentMessage", text: long }, { type: "commandExecution", command: "PRIVATE-COMMAND", aggregatedOutput: "PRIVATE-OUTPUT" }] }], nextCursor: "cursor3" } } });
    const result = await f.adapter.inspect("thread-saved", "cursor2");
    expect(result).toMatchObject({ threadId: "thread-saved", status: "notLoaded", nextCursor: "cursor3" });
    expect(result.turns[0].items[0].text).toBe(long.slice(0, 8000));
    expect(result.turns[0].items[1]).toEqual({ type: "commandExecution" });
    expect(f.adapter.activeCount()).toBe(0); // Old persisted inProgress is not a live executor.
    expect(f.requests().find((m) => m.method === "thread/turns/list").params).toEqual({ threadId: "thread-saved", cursor: "cursor2", limit: 5, itemsView: "full" });
    expect(f.requests().some((m) => ["thread/start", "thread/resume", "turn/start"].includes(m.method))).toBe(false);
  });

  it("recovers a saved ID by read and resumes only that ID for an explicit new turn", async () => {
    const f = fixture({ savedCwd: path.join(dir, "saved-job") });
    expect((await f.adapter.inspect("thread-saved")).turns[0].items[0].text).toBe("真实任务 marker");
    const result = await f.adapter.resume("thread-saved", "明确的新指令");
    expect(result).toMatchObject({ status: "started", session: { threadId: "thread-saved" } });
    const requests = f.requests();
    expect(requests.find((m) => m.method === "thread/resume").params).toEqual({ threadId: "thread-saved" });
    expect(requests.find((m) => m.method === "turn/start").params.threadId).toBe("thread-saved");
    expect(requests.some((m) => ["thread/start", "thread/fork"].includes(m.method))).toBe(false);
  });

  it("does not append a new turn to a thread that is already active", async () => {
    const f = fixture({ threadStatus: "active" });
    expect(await f.adapter.resume("thread-saved", "不要重复发")).toMatchObject({ status: "blocked", code: "thread_active" });
    expect(f.requests().some((m) => ["thread/resume", "turn/start"].includes(m.method))).toBe(false);
  });

  it("rechecks authorization after thread/resume and never sends a new turn when refused", async () => {
    const f = fixture({ savedCwd: path.join(dir, "saved-job") });
    const result = await f.adapter.resume("thread-saved", "明确的新指令", async () => {
      expect(f.requests().some((m) => m.method === "thread/resume")).toBe(true);
      throw new Error("policy disabled during resume");
    });
    expect(result).toMatchObject({ status: "blocked", code: "before_turn_blocked", threadId: "thread-saved" });
    expect(f.requests().some((m) => m.method === "turn/start")).toBe(false);
  });
});
