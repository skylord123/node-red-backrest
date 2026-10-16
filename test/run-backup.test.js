const assert = require("assert");
const { getBackrest } = require("./fixtures/backrest");
const nr = require("./fixtures/nodered");

describe("Run Backup node", function () {
    let server;

    before(async function () {
        server = await getBackrest();
        await server.addPlan({ id: "broken-plan", repo: "test-repo", paths: ["/does-not-exist"] });
        nr.withNodes(nr.coreNode("common/25-catch.js"));
    });

    after(function () {
        nr.withNodes();
    });

    function flow(props = {}) {
        return [
            { id: "f1", type: "tab" },
            { id: "cfg", type: "backrest-config", name: "test", autoReconnect: true, reconnectInterval: "500" },
            {
                id: "backup", type: "backrest-run-backup", z: "f1", config: "cfg",
                planValue: "test-plan", planType: "backrest-plan", dryRunValue: "false", dryRunType: "bool", wait: true,
                wires: [["ok"], ["failed"]], ...props
            },
            { id: "ok", type: "helper", z: "f1" },
            { id: "failed", type: "helper", z: "f1" },
            ...nr.catchNodes()
        ];
    }

    async function setup(props) {
        await nr.load(flow(props), server);
        return { ok: nr.collect("ok"), failed: nr.collect("failed"), caught: nr.collect("caught") };
    }

    it("runs a backup and sends the result when it finishes", async function () {
        const { ok } = await setup();
        nr.send("backup", { topic: "nightly" });
        const msg = await ok.next();
        const r = msg.payload;
        assert.strictEqual(r.status, "STATUS_SUCCESS");
        assert.strictEqual(r.planId, "test-plan");
        assert.strictEqual(r.repoId, "test-repo");
        assert.strictEqual(r.dryRun, false);
        assert.match(r.snapshotId, /^[0-9a-f]{64}$/);
        assert.strictEqual(typeof r.summary.totalFilesProcessed, "number");
        assert.ok(r.durationMs >= 0);
        assert.strictEqual(msg.operation.id, r.operationId);
        assert.strictEqual(msg.topic, "nightly", "input message properties are kept");

        const snaps = await server.raw("ListSnapshots", { repoId: "test-repo", planId: "test-plan" });
        assert.ok(snaps.snapshots.some(s => s.id === r.snapshotId));
    });

    it("runs a dry run with the plan from the message", async function () {
        const { ok } = await setup({ planValue: "plan", planType: "msg", dryRunValue: "dry", dryRunType: "msg" });
        nr.send("backup", { plan: "test-plan", dry: true });
        const r = (await ok.next()).payload;
        assert.strictEqual(r.status, "STATUS_SUCCESS");
        assert.strictEqual(r.dryRun, true);
        assert.strictEqual(r.snapshotId, undefined);
    });

    it("sends failed backups to the second output", async function () {
        const { ok, failed } = await setup({ planValue: "broken-plan" });
        nr.send("backup", {});
        const r = (await failed.next()).payload;
        assert.strictEqual(r.status, "STATUS_ERROR");
        assert.strictEqual(r.planId, "broken-plan");
        assert.ok(r.message, "error message");
        assert.strictEqual(ok.messages.length, 0);
    });

    it("sends unknown plans to Catch nodes", async function () {
        const { caught } = await setup({ planValue: "no-such-plan" });
        nr.send("backup", {});
        const msg = await caught.next();
        assert.match(msg.error.message, /not found/);
    });

    it("can send the result as soon as the backup is queued", async function () {
        const { ok } = await setup({ wait: false });
        nr.send("backup", {});
        const r = (await ok.next()).payload;
        assert.ok(["STATUS_PENDING", "STATUS_INPROGRESS"].includes(r.status), r.status);
        await server.waitForOperation(r.operationId);
    });

    it("tracks several backups at once", async function () {
        const { ok } = await setup();
        nr.send("backup", { _id: 1 });
        nr.send("backup", { _id: 2 });
        const [a, b] = await Promise.all([ok.next(m => m._id === 1), ok.next(m => m._id === 2)]);
        assert.notStrictEqual(a.payload.operationId, b.payload.operationId);
        assert.strictEqual(a.payload.status, "STATUS_SUCCESS");
        assert.strictEqual(b.payload.status, "STATUS_SUCCESS");
    });

    it("still finishes when the event stream isn't available", async function () {
        const { ok } = await setup();
        nr.getNode("cfg").subscribeOperationEvents = () => {};
        nr.send("backup", {});
        assert.strictEqual((await ok.next()).payload.status, "STATUS_SUCCESS");
    });

    it("keeps waiting when the backup request is cut off (such as a proxy timeout)", async function () {
        const { ok } = await setup();
        const cfg = nr.getNode("cfg");
        const request = cfg.request.bind(cfg);
        cfg.request = (method, body) => {
            if (method !== "Backup") return request(method, body);
            request(method, body).catch(() => {});
            return Promise.reject(Object.assign(new Error("Backrest Backup failed (504): Gateway Timeout"), { status: 504 }));
        };
        nr.send("backup", {});
        assert.strictEqual((await ok.next()).payload.status, "STATUS_SUCCESS");
    });

    it("shows the result in its status", async function () {
        const { ok } = await setup();
        const statuses = [];
        nr.getNode("backup").on("call:status", call => statuses.push(call.args[0]));
        nr.send("backup", {});
        await ok.next();
        const last = statuses[statuses.length - 1];
        assert.strictEqual(last.fill, "green");
        assert.match(last.text, /^test-plan: success at /);
    });
});
