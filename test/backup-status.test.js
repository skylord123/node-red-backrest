const assert = require("assert");
const { getBackrest } = require("./fixtures/backrest");
const nr = require("./fixtures/nodered");

describe("Backup Status node", function () {
    let server;

    before(async function () {
        server = await getBackrest();
        await server.addPlan({ id: "status-ok", repo: "test-repo", paths: ["/source/sub"] });
        await server.addPlan({ id: "status-broken", repo: "test-repo", paths: ["/does-not-exist"] });
        await server.raw("Backup", { value: "status-ok" });
        await server.raw("Backup", { value: "status-broken" }).catch(() => {}); // fails, as intended
        nr.withNodes(require("@node-red/nodes/core/common/25-catch.js"));
    });

    after(function () {
        nr.withNodes();
    });

    async function run(props, msg = {}) {
        await nr.load([
            { id: "f1", type: "tab" },
            { id: "cfg", type: "backrest-config", name: "test" },
            {
                id: "status", type: "backrest-backup-status", z: "f1", config: "cfg", show: "plans",
                targetValue: "", targetType: "backrest-any", output: "each", onlyProblems: false,
                wires: [["out"]], ...props
            },
            { id: "out", type: "helper", z: "f1" },
            ...nr.catchNodes()
        ], server);
        const out = nr.collect("out");
        const caught = nr.collect("caught");
        nr.send("status", { _id: "check", ...msg });
        await new Promise(r => setTimeout(r, 1500));
        return { out: out.messages, caught: caught.messages };
    }

    it("sends one message per plan", async function () {
        const { out } = await run();
        const ok = out.find(m => m.topic === "status-ok");
        const broken = out.find(m => m.topic === "status-broken");
        assert.ok(ok && broken, out.map(m => m.topic).join());
        assert.ok(out.every(m => m._id === "check"), "input properties kept");

        assert.strictEqual(ok.payload.type, "plan");
        assert.strictEqual(ok.payload.repo, "test-repo");
        assert.strictEqual(ok.payload.state, "ok");
        assert.strictEqual(ok.payload.healthy, true);
        assert.strictEqual(ok.payload.lastBackup.status, "STATUS_SUCCESS");
        assert.strictEqual(typeof ok.payload.lastBackup.time, "number");
        assert.ok(ok.payload.last30Days.success >= 1);
        assert.ok(ok.payload.protectedBytes > 0);

        assert.strictEqual(broken.payload.state, "error");
        assert.strictEqual(broken.payload.healthy, false);
        assert.ok(broken.payload.last30Days.failed >= 1);
    });

    it("reports a single plan picked in the editor or read from the message", async function () {
        let { out } = await run({ targetType: "backrest-plan", targetValue: "status-ok" });
        assert.deepStrictEqual(out.map(m => m.topic), ["status-ok"]);
        ({ out } = await run({ targetType: "msg", targetValue: "plan" }, { plan: "status-broken" }));
        assert.deepStrictEqual(out.map(m => m.topic), ["status-broken"]);
    });

    it("only sends plans that need attention", async function () {
        const { out } = await run({ onlyProblems: true });
        assert.ok(out.length >= 1);
        assert.ok(out.some(m => m.topic === "status-broken"));
        assert.ok(out.every(m => !m.payload.healthy));
    });

    it("sends nothing when everything checked is healthy", async function () {
        const { out } = await run({ onlyProblems: true, targetType: "backrest-plan", targetValue: "status-ok", output: "all" });
        assert.strictEqual(out.length, 0);
    });

    it("can send a single message with a list", async function () {
        const { out } = await run({ output: "all" });
        assert.strictEqual(out.length, 1);
        assert.ok(Array.isArray(out[0].payload));
        assert.ok(out[0].payload.some(s => s.id === "status-ok"));
        assert.strictEqual(out[0].healthy, false);
    });

    it("reports repositories", async function () {
        const { out } = await run({ show: "repos", targetType: "backrest-repo", targetValue: "test-repo" });
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].payload.type, "repo");
        assert.strictEqual(out[0].payload.id, "test-repo");
        assert.strictEqual(out[0].payload.repo, undefined);
    });

    it("sends unknown plans to Catch nodes", async function () {
        const { out, caught } = await run({ targetType: "str", targetValue: "nope" });
        assert.strictEqual(out.length, 0);
        assert.match(caught[0].error.message, /Plan nope not found/);
    });

    it("shows a summary in its status", async function () {
        await nr.load([
            { id: "f1", type: "tab" },
            { id: "cfg", type: "backrest-config", name: "test" },
            { id: "status", type: "backrest-backup-status", z: "f1", config: "cfg", show: "plans", targetType: "backrest-any", output: "all", wires: [["out"]] },
            { id: "out", type: "helper", z: "f1" }
        ], server);
        const out = nr.collect("out");
        const statuses = [];
        nr.getNode("status").on("call:status", call => statuses.push(call.args[0]));
        nr.send("status", {});
        await out.next();
        const last = statuses[statuses.length - 1];
        assert.strictEqual(last.fill, "red");
        assert.match(last.text, /\d+ error, .*\d+ ok/);
    });
});
