const assert = require("assert");
const { getBackrest, waitFor } = require("./fixtures/backrest");
const { CuttableProxy } = require("./fixtures/proxy");
const nr = require("./fixtures/nodered");

describe("Catching up after a reconnect", function () {
    let server, proxy;

    before(async function () {
        server = await getBackrest();
    });

    beforeEach(async function () {
        proxy = await new CuttableProxy(server.url).start();
    });

    afterEach(async function () {
        await proxy.stop();
    });

    function flow({ config = {}, events = {} } = {}) {
        return [
            { id: "f1", type: "tab" },
            { id: "cfg", type: "backrest-config", name: "test", autoReconnect: true, reconnectInterval: "300", ...config },
            {
                id: "ev-final", type: "backrest-operation-events", z: "f1", config: "cfg", mode: "always",
                output: "operation", when: "final", types: ["backup"], wires: [["final-out"]], ...events
            },
            { id: "ev-raw", type: "backrest-operation-events", z: "f1", config: "cfg", mode: "always", output: "event", wires: [["raw-out"]] },
            { id: "final-out", type: "helper", z: "f1" },
            { id: "raw-out", type: "helper", z: "f1" }
        ];
    }

    async function load(options) {
        await nr.load(flow(options), server, {
            cfg: { backrest_url: proxy.url, username: server.username, password: server.password }
        });
        const cfg = nr.getNode("cfg");
        // Connected once the baseline is known and the stream is open.
        await cfg.baselinePromise;
        await waitFor(() => cfg.operationStreamCall && cfg.tracker && cfg.tracker.modno !== null, 10000, "stream");
        return { cfg, final: nr.collect("final-out"), raw: nr.collect("raw-out") };
    }

    /** Back up while the connection is down, then restore it. */
    async function backupWhileDisconnected(cfg, value = "test-plan") {
        await proxy.cut();
        await waitFor(() => !cfg.operationStreamCall || cfg.reconnectAttempts > 0, 10000, "the stream to drop");
        const before = (await server.raw("GetOperations", { selector: { planId: value }, lastN: 1 })).operations || [];
        await server.raw("Backup", { value, dryRun: true });
        const after = await server.raw("GetOperations", { selector: { planId: value }, lastN: 1 });
        const op = after.operations[after.operations.length - 1];
        assert.notStrictEqual(op.id, before.length ? before[before.length - 1].id : undefined);
        await proxy.restore();
        return op;
    }

    it("sends operations that finished while disconnected", async function () {
        const { cfg, final, raw } = await load();
        const missed = await backupWhileDisconnected(cfg);

        const msg = await final.next(m => m.payload.id === missed.id, 15000);
        assert.strictEqual(msg.catchUp, true);
        assert.strictEqual(msg.status, "STATUS_SUCCESS");
        assert.strictEqual(msg.event, "created");
        assert.strictEqual(msg.payload.operationBackup.dryRun, true);

        const rawMsg = await raw.next(m => m.payload.catchUp && JSON.stringify(m.payload).includes(`"id":"${missed.id}"`), 15000);
        assert.strictEqual(rawMsg.payload.event, "createdOperations");
    });

    it("doesn't send anything twice", async function () {
        const { cfg, final, raw } = await load();
        // Delivered live before the drop
        await server.raw("Backup", { value: "test-plan", dryRun: true });
        await waitFor(() => final.messages.length === 1, 10000, "live backup");
        const missed = await backupWhileDisconnected(cfg);
        await final.next(m => m.payload.id === missed.id, 15000);
        // Live again afterwards
        await server.raw("Backup", { value: "test-plan", dryRun: true });
        await waitFor(() => final.messages.length === 3, 10000, "backup after reconnecting");
        await new Promise(r => setTimeout(r, 1500));

        const finals = final.messages.map(m => m.payload.id);
        assert.strictEqual(new Set(finals).size, finals.length, `duplicates: ${finals}`);
        assert.deepStrictEqual(final.messages.map(m => !!m.catchUp), [false, true, false]);

        // Raw events: no operation change (id + modno) delivered twice
        const changes = raw.messages.flatMap(m => {
            const list = (m.payload.createdOperations || m.payload.updatedOperations || {}).operations || [];
            return list.map(o => `${o.id}@${o.modno}`);
        });
        assert.strictEqual(new Set(changes).size, changes.length, "raw duplicates");
    });

    it("doesn't send operations from before it subscribed", async function () {
        // Lots of history exists already; drop the connection right after subscribing.
        await server.raw("Backup", { value: "test-plan", dryRun: true });
        const { cfg, final, raw } = await load();
        await proxy.cut();
        await waitFor(() => !cfg.operationStreamCall || cfg.reconnectAttempts > 0, 10000, "the stream to drop");
        await proxy.restore();
        await waitFor(() => cfg.operationStreamCall && !cfg.catchUpPending, 15000, "the catch-up to finish");
        await new Promise(r => setTimeout(r, 500));
        assert.strictEqual(final.messages.length, 0);
        assert.strictEqual(raw.messages.length, 0);
    });

    it("can be turned off", async function () {
        const { cfg, final } = await load({ config: { catchUp: false } });
        const missed = await backupWhileDisconnected(cfg);
        await waitFor(() => cfg.operationStreamCall && cfg.reconnectAttempts === 0 || cfg.operationStreamCall, 15000, "reconnect");
        await new Promise(r => setTimeout(r, 2500));
        assert.ok(!final.messages.some(m => m.payload.id === missed.id), "missed backup not sent");
    });

    it("doesn't catch up after unsubscribing on purpose", async function () {
        const { cfg, final } = await load({
            events: { mode: "manual", triggerValue: "payload", triggerType: "msg" }
        });
        // "final" starts unsubscribed in manual mode; "raw" keeps the stream open. Subscribe, then unsubscribe.
        nr.send("ev-final", { payload: true });
        await new Promise(r => setTimeout(r, 300));
        nr.send("ev-final", { payload: false });
        await server.raw("Backup", { value: "test-plan", dryRun: true });
        nr.send("ev-final", { payload: true });
        await new Promise(r => setTimeout(r, 2500));
        assert.strictEqual(final.messages.length, 0);
        assert.ok(cfg.operationStreamCall);
    });

    it("stops reconnecting when the node is closed", async function () {
        const { cfg } = await load({ config: { reconnectInterval: "1000" } });
        await proxy.cut();
        await waitFor(() => cfg.reconnectTimer, 10000, "a reconnect to be scheduled");
        // The test helper stops capturing the log on unload, so record errors directly.
        const errors = [];
        cfg.error = msg => errors.push(String(msg));
        await nr.helper.unload();
        await new Promise(r => setTimeout(r, 1500));
        assert.strictEqual(cfg.reconnectTimer, null);
        assert.deepStrictEqual(errors, []);
    });

    it("lets Run Backup finish when the connection drops during the backup", async function () {
        nr.withNodes();
        await nr.load([
            { id: "f1", type: "tab" },
            { id: "cfg", type: "backrest-config", name: "test", autoReconnect: true, reconnectInterval: "300" },
            {
                id: "backup", type: "backrest-run-backup", z: "f1", config: "cfg", planValue: "test-plan",
                planType: "backrest-plan", dryRunValue: "true", dryRunType: "bool", wait: true, wires: [["ok"], ["failed"]]
            },
            { id: "ok", type: "helper", z: "f1" },
            { id: "failed", type: "helper", z: "f1" }
        ], server, { cfg: { backrest_url: proxy.url, username: server.username, password: server.password } });
        const ok = nr.collect("ok");
        nr.send("backup", {});
        await new Promise(r => setTimeout(r, 300));
        await proxy.cut();
        await new Promise(r => setTimeout(r, 1500));
        await proxy.restore();
        const msg = await ok.next(() => true, 30000);
        assert.strictEqual(msg.payload.status, "STATUS_SUCCESS");
    });
});
