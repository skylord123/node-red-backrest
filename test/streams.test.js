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

    it("streams operation events while always listening", async function () {
        await nr.load(flow(), server);
        const out = nr.collect("out");
        await new Promise(r => setTimeout(r, 500)); // let the stream connect
        await server.raw("Backup", { value: "test-plan", dryRun: true });

        const created = await out.next(m => m.payload.created_operations &&
            m.payload.created_operations.operations.some(o => o.op === "operation_backup"));
        const op = created.payload.created_operations.operations.find(o => o.op === "operation_backup");
        assert.strictEqual(op.plan_id, "test-plan");
        assert.strictEqual(op.operation_backup.dry_run, true);
        await out.next(m => m.payload.updated_operations &&
            m.payload.updated_operations.operations.some(o => o.id === op.id && o.status === "STATUS_SUCCESS"));
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
        await out.next(m => m.payload.created_operations);

        node.receive({ payload: false });
        await new Promise(r => setTimeout(r, 200));
        const count = out.messages.length;
        await server.raw("Backup", { value: "test-plan", dryRun: true });
        await new Promise(r => setTimeout(r, 1000));
        assert.strictEqual(out.messages.length, count, "no events after unsubscribing");
    });
});

describe("Get Logs node", function () {
    let server;

    before(async function () {
        server = await getBackrest();
    });

    it("streams the output of a command", async function () {
        await nr.load([
            { id: "f1", type: "tab" },
            { id: "cfg", type: "backrest-config", name: "test" },
            {
                id: "logs", type: "backrest-get-logs", z: "f1", config: "cfg",
                triggerValue: "true", triggerType: "bool", logRefValue: "logRef", logRefType: "msg", wires: [["out"]]
            },
            { id: "out", type: "helper", z: "f1" }
        ], server);
        const out = nr.collect("out");

        const { operationId } = await server.raw("RunCommand", { repoId: "test-repo", command: "snapshots" });
        const op = await server.waitForOperation(operationId);
        nr.send("logs", { logRef: op.operationRunCommand.outputLogref });
        await out.next(m => /restic snapshots/.test(String(m.payload)));
    });
});
