const assert = require("assert");
const { getBackrest } = require("./fixtures/backrest");
const nr = require("./fixtures/nodered");

nr.withNodes(nr.coreNode("common/25-catch.js"));

const ENDPOINTS = [
    "GetOperations", "GetConfig", "SetConfig", "SetupSftp", "CheckRepoExists", "AddRepo",
    "RemoveRepo", "ListSnapshots", "ListSnapshotFiles", "Backup", "DoRepoTask", "Forget",
    "Restore", "Cancel", "RunCommand", "GetDownloadURL", "ClearHistory", "PathAutocomplete",
    "GetSummaryDashboard", "GeneratePairingToken"
];

// One API node per endpoint, all wired to the same helper node.
function apiFlow(extra = {}) {
    const flow = [
        { id: "f1", type: "tab" },
        { id: "cfg", type: "backrest-config", name: "test" },
        { id: "out", type: "helper", z: "f1" },
        ...nr.catchNodes()
    ];
    for (const ep of ENDPOINTS) {
        flow.push({
            id: `api-${ep}`, type: "backrest-api", z: "f1", config: "cfg",
            endpoint: `/v1.Backrest/${ep}`, inputType: "msg", inputValue: "payload",
            outputType: "msg", outputValue: "payload", wires: [["out"]], ...extra
        });
    }
    return flow;
}

describe("API node", function () {
    let server, out, caught;
    let seq = 0;

    // Call an endpoint through its API node and resolve with the response (or the caught error).
    function call(ep, payload = {}) {
        const id = ++seq;
        nr.send(`api-${ep}`, { payload, _seq: id });
        return Promise.race([
            out.next(m => m._seq === id).then(m => m.payload),
            caught.next(m => m._seq === id).then(m => {
                throw Object.assign(new Error(m.error.message), { caught: m });
            })
        ]);
    }

    before(async function () {
        server = await getBackrest();
    });

    beforeEach(async function () {
        await nr.load(apiFlow(), server);
        out = nr.collect("out");
        caught = nr.collect("caught");
    });

    it("reads the config", async function () {
        const config = await call("GetConfig");
        assert.strictEqual(config.instance, "nrtest");
        assert.ok(config.plans.some(p => p.id === "test-plan"));
    });

    it("checks, adds and removes repositories", async function () {
        const exists = await call("CheckRepoExists", { repo: { id: "test-repo", uri: "/repos/test", password: "repopass" } });
        assert.strictEqual(exists.exists, true);

        const added = await call("AddRepo", { repo: { id: "temp-repo", uri: "/repos/temp", password: "x" } });
        assert.ok(added.repos.some(r => r.id === "temp-repo"));

        const removed = await call("RemoveRepo", { repoId: "temp-repo" });
        assert.ok(!removed.repos.some(r => r.id === "temp-repo"));
    });

    it("sets up SFTP keys and pairing tokens", async function () {
        const sftp = await call("SetupSftp", { host: "sftp.example.invalid", port: "22", username: "backup" });
        assert.match(sftp.publicKey, /^ssh-/);

        const token = await call("GeneratePairingToken", {
            label: "test", ttlSeconds: 600, maxUses: 1,
            permissions: [{ type: "PERMISSION_READ_OPERATIONS", scopes: ["*"] }]
        });
        assert.match(token.token, /#nrtest$/);
    });

    it("runs backups, including dry runs", async function () {
        await call("Backup", { value: "test-plan", dryRun: true });
        await call("Backup", { value: "test-plan" });
        const ops = await call("GetOperations", { selector: { planId: "test-plan" } });
        const backups = ops.operations.filter(o => o.operationBackup);
        assert.ok(backups.some(o => o.operationBackup.dryRun === true && !o.snapshotId), "dry run backup without snapshot");
        assert.ok(backups.some(o => !o.operationBackup.dryRun && o.snapshotId), "real backup with snapshot");
    });

    it("schedules tasks and returns their operation IDs", async function () {
        const stats = await call("DoRepoTask", { repoId: "test-repo", task: "TASK_STATS" });
        assert.ok(stats.operationId);
        await server.waitForOperation(stats.operationId);

        const forget = await call("Forget", { repoId: "test-repo", planId: "test-plan" });
        assert.ok(forget.operationId);
        await server.waitForOperation(forget.operationId);

        const cmd = await call("RunCommand", { repoId: "test-repo", command: "snapshots" });
        const op = await server.waitForOperation(cmd.operationId);
        assert.strictEqual(op.status, "STATUS_SUCCESS");
    });

    it("lists snapshots, restores and creates download links", async function () {
        await call("Backup", { value: "test-plan" });
        const { snapshots } = await call("ListSnapshots", { repoId: "test-repo", planId: "test-plan" });
        const snap = snapshots[snapshots.length - 1].id;

        const files = await call("ListSnapshotFiles", { repoId: "test-repo", snapshotId: snap, path: "/source" });
        assert.ok(files.entries.some(e => e.name === "a.txt"));

        const restore = await call("Restore", {
            repoId: "test-repo", planId: "test-plan", snapshotId: snap,
            path: "/source/a.txt", target: `/tmp/restore-${Date.now()}`
        });
        const restoreOp = await server.waitForOperation(restore.operationId);
        assert.strictEqual(restoreOp.status, "STATUS_SUCCESS");

        const link = await call("GetDownloadURL", { opId: restoreOp.id });
        assert.match(link.value, /download\//);

        const ops = await call("GetOperations", { selector: { snapshotId: snap } });
        const index = ops.operations.find(o => o.operationIndexSnapshot);
        const fileLink = await call("GetDownloadURL", { opId: index.id, filePath: "/source/a.txt" });
        assert.match(fileLink.value, /download\//);
    });

    it("filters operations by repo GUID and modno", async function () {
        const byRepo = await call("GetOperations", { lastN: 1000, selector: { repoGuid: server.repoGuid } });
        assert.ok(byRepo.operations.length > 0);
        assert.ok(byRepo.operations.every(o => o.repoId === "test-repo"));

        const byModno = await call("GetOperations", { selector: { modnoGte: "1" } });
        assert.ok(byModno.operations.length > 0);
    });

    it("returns the summary dashboard", async function () {
        await call("Backup", { value: "test-plan" });
        const summary = await call("GetSummaryDashboard");
        const plan = summary.planSummaries.find(p => p.id === "test-plan");
        assert.ok("protectedBytes" in plan);
        assert.ok(plan.historyLast30days.length > 0);
    });

    it("handles the remaining endpoints", async function () {
        await call("Cancel", { operationId: "999999" });
        await call("ClearHistory", { selector: { planId: "test-plan" }, onlyFailed: true });
        const paths = await call("PathAutocomplete", { value: "/" });
        assert.ok(paths.values.includes("source/") || JSON.stringify(paths).includes("source"));
        const config = await call("GetConfig");
        const saved = await call("SetConfig", config);
        assert.strictEqual(Number(saved.modno), Number(config.modno) + 1);
    });

    it("sends request errors to Catch nodes", async function () {
        await assert.rejects(call("Backup", { value: "no-such-plan" }), /404/);
    });

    it("can store the response in flow context", async function () {
        await nr.load(apiFlow({ outputType: "flow", outputValue: "backrestConfig" }), server);
        out = nr.collect("out");
        caught = nr.collect("caught");
        await call("GetConfig");
        const node = nr.getNode("api-GetConfig");
        assert.strictEqual(node.context().flow.get("backrestConfig").instance, "nrtest");
    });

    it("rejects a wrong password", async function () {
        const flow = apiFlow();
        await nr.load(flow, server, { cfg: { backrest_url: server.url, username: "admin", password: "wrong" } });
        out = nr.collect("out");
        caught = nr.collect("caught");
        await assert.rejects(call("GetConfig"), /401/);
    });
});
