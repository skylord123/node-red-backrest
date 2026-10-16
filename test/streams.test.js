const assert = require("assert");
const { getBackrest } = require("./fixtures/backrest");
const nr = require("./fixtures/nodered");

describe("Operation Events node", function () {
    let server;

    before(async function () {
        server = await getBackrest();
    });

    function flow(props = {}) {
        return [
            { id: "f1", type: "tab" },
            { id: "cfg", type: "backrest-config", name: "test", autoReconnect: true, reconnectInterval: "500" },
            { id: "events", type: "backrest-operation-events", z: "f1", config: "cfg", mode: "always", wires: [["out"]], ...props },
            { id: "out", type: "helper", z: "f1" }
        ];
    }

    it("sends one message per operation", async function () {
        await nr.load(flow({ output: "operation", when: "status" }), server);
        const out = nr.collect("out");
        await new Promise(r => setTimeout(r, 500));
        await server.raw("Backup", { value: "test-plan", dryRun: true });

        const created = await out.next(m => m.event === "created" && m.operationType === "backup");
        assert.strictEqual(created.topic, "test-plan");
        assert.strictEqual(created.payload.planId, "test-plan");
        assert.strictEqual(created.payload.operationBackup.dryRun, true);
        const id = created.payload.id;
        await out.next(m => m.payload.id === id && m.status === "STATUS_SUCCESS");
        const updates = out.messages.filter(m => m.payload.id === id).map(m => m.status);
        assert.deepStrictEqual(updates, [...new Set(updates)], "each status is only sent once");
    });

    it("filters by plan, type and finished operations", async function () {
        await server.addPlan({ id: "other-plan", repo: "test-repo", paths: ["/source/sub"] });
        await nr.load(flow({
            output: "operation", when: "final", planType: "backrest-plan", planValue: "other-plan", types: ["backup"]
        }), server);
        const out = nr.collect("out");
        await new Promise(r => setTimeout(r, 500));
        await server.raw("Backup", { value: "test-plan", dryRun: true });
        await server.raw("Backup", { value: "other-plan", dryRun: true });
        const msg = await out.next(m => m.payload.planId === "other-plan");
        await new Promise(r => setTimeout(r, 1000));
        assert.ok(out.messages.every(m => m.payload.planId === "other-plan"), "only other-plan");
        assert.ok(out.messages.every(m => m.operationType === "backup"), "only backups");
        assert.deepStrictEqual(out.messages.map(m => m.status), [msg.status], "one message, when it finished");
        assert.strictEqual(msg.status, "STATUS_SUCCESS");
    });

    it("reads the plan filter from flow context", async function () {
        await nr.load(flow({ output: "operation", when: "final", planType: "flow", planValue: "watchedPlan" }), server);
        const out = nr.collect("out");
        nr.getNode("events").context().flow.set("watchedPlan", "other-plan");
        await new Promise(r => setTimeout(r, 500));
        await server.raw("Backup", { value: "test-plan", dryRun: true });
        await server.raw("Backup", { value: "other-plan", dryRun: true });
        await out.next(m => m.payload.planId === "other-plan");
        assert.ok(out.messages.every(m => m.payload.planId === "other-plan"));
    });

    it("streams raw operation events (nodes from before 1.0)", async function () {
        await nr.load(flow(), server);
        const out = nr.collect("out");
        await new Promise(r => setTimeout(r, 500)); // let the stream connect
        await server.raw("Backup", { value: "test-plan", dryRun: true });

        const created = await out.next(m => m.payload.createdOperations &&
            m.payload.createdOperations.operations.some(o => o.op === "operationBackup"));
        const op = created.payload.createdOperations.operations.find(o => o.op === "operationBackup");
        assert.strictEqual(op.planId, "test-plan");
        assert.strictEqual(op.operationBackup.dryRun, true);
        await out.next(m => m.payload.updatedOperations &&
            m.payload.updatedOperations.operations.some(o => o.id === op.id && o.status === "STATUS_SUCCESS"));
    });

    it("does not send keep-alive messages", async function () {
        await nr.load(flow(), server);
        const out = nr.collect("out");
        await new Promise(r => setTimeout(r, 500));
        // Backrest only sends these once a minute, so emit one on the live stream.
        const call = nr.getNode("cfg").operationStreamCall;
        call.emit("data", { keepAlive: {}, event: "keepAlive" });
        call.emit("data", { createdOperations: { operations: [] }, event: "createdOperations" });
        await out.next(m => m.payload.event === "createdOperations");
        assert.ok(!out.messages.some(m => m.payload.event === "keepAlive"));
    });

    it("subscribes and unsubscribes on trigger messages", async function () {
        await nr.load(flow({ mode: "manual", triggerValue: "payload", triggerType: "msg" }), server);
        const out = nr.collect("out");
        const node = nr.getNode("events");

        await server.raw("Backup", { value: "test-plan", dryRun: true });
        assert.strictEqual(out.messages.length, 0, "no events before subscribing");

        node.receive({ payload: true });
        await new Promise(r => setTimeout(r, 500));
        await server.raw("Backup", { value: "test-plan", dryRun: true });
        await out.next(m => m.payload.createdOperations);

        node.receive({ payload: false });
        await new Promise(r => setTimeout(r, 200));
        const count = out.messages.length;
        await server.raw("Backup", { value: "test-plan", dryRun: true });
        await new Promise(r => setTimeout(r, 1000));
        assert.strictEqual(out.messages.length, count, "no events after unsubscribing");
    });
});

describe("Server config node", function () {
    let server;

    before(async function () {
        server = await getBackrest();
    });

    it("closes its connection when it is stopped", async function () {
        await nr.load([{ id: "cfg", type: "backrest-config", name: "test" }], server);
        const client = nr.getNode("cfg").client;
        await nr.helper.unload();
        const state = client.getChannel().getConnectivityState(false);
        assert.strictEqual(state, 4, `channel state ${state} (4 is SHUTDOWN)`);
    });
});
