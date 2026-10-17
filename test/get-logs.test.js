const assert = require("assert");
const { getBackrest } = require("./fixtures/backrest");
const nr = require("./fixtures/nodered");

describe("Get Logs node", function () {
    let server, commandOp;

    before(async function () {
        server = await getBackrest();
        nr.withNodes(
            nr.coreNode("common/25-catch.js"),
            nr.coreNode("common/24-complete.js")
        );
        const { operationId } = await server.raw("RunCommand", { repoId: "test-repo", command: "snapshots" });
        commandOp = await server.waitForOperation(operationId);
    });

    after(function () {
        nr.withNodes();
    });

    function flow(props) {
        return [
            { id: "f1", type: "tab" },
            { id: "cfg", type: "backrest-config", name: "test" },
            {
                id: "logs", type: "backrest-get-logs", z: "f1", config: "cfg",
                triggerValue: "true", triggerType: "bool", wires: [["out"]], ...props
            },
            { id: "out", type: "helper", z: "f1" },
            { id: "completer", type: "complete", z: "f1", scope: ["logs"], uncaught: false, wires: [["completed"]] },
            { id: "completed", type: "helper", z: "f1" },
            ...nr.catchNodes()
        ];
    }

    const isCommandOutput = m => /restic snapshots/.test(String(m.payload));

    it("streams the logs of an operation picked in the editor", async function () {
        await nr.load(flow({ source: "operation", operationValue: commandOp.id, operationType: "backrest-operation" }), server);
        const out = nr.collect("out");
        nr.send("logs", { payload: "go", topic: "keep-me" });
        const msg = await out.next(isCommandOutput);
        assert.strictEqual(msg.operationId, commandOp.id);
        assert.strictEqual(msg.logRef, commandOp.operationRunCommand.outputLogref);
        assert.strictEqual(msg.topic, "keep-me", "input message properties are kept");
    });

    it("takes the operation from the message as an ID, an operation or a Run Backup result", async function () {
        await nr.load(flow({ source: "operation", operationValue: "payload", operationType: "msg" }), server);
        const out = nr.collect("out");
        for (const payload of [commandOp.id, Number(commandOp.id), commandOp, { operationId: commandOp.id }]) {
            const before = out.messages.length;
            nr.send("logs", { payload });
            await out.next(m => out.messages.indexOf(m) >= before && isCommandOutput(m));
        }
    });

    it("streams a log reference directly (nodes from before 1.0)", async function () {
        // No "source" property, like nodes saved by older versions
        await nr.load(flow({ logRefValue: "logRef", logRefType: "msg" }), server);
        const out = nr.collect("out");
        nr.send("logs", { logRef: commandOp.operationRunCommand.outputLogref });
        await out.next(isCommandOutput);
    });

    it("waits for a queued operation to start", async function () {
        await nr.load(flow({ source: "operation", operationValue: "payload", operationType: "msg" }), server);
        const out = nr.collect("out");
        const caught = nr.collect("caught");
        // Report the operation as queued (no log yet) the first two times it is looked up.
        const cfg = nr.getNode("cfg");
        const request = cfg.request.bind(cfg);
        let lookups = 0;
        cfg.request = async (method, body) => {
            const res = await request(method, body);
            if (method === "GetOperations" && ++lookups <= 2) {
                return { operations: res.operations.map(o => ({ ...o, status: "STATUS_PENDING", logref: "", operationRunCommand: {} })) };
            }
            return res;
        };
        nr.send("logs", { payload: { operationId: commandOp.id } });
        await out.next(isCommandOutput);
        assert.strictEqual(lookups, 3);
        assert.strictEqual(caught.messages.length, 0);
    });

    it("reports operations that finished without a log", async function () {
        await nr.load(flow({ source: "operation", operationValue: "payload", operationType: "msg" }), server);
        const caught = nr.collect("caught");
        const cfg = nr.getNode("cfg");
        const request = cfg.request.bind(cfg);
        cfg.request = async (method, body) => {
            const res = await request(method, body);
            return { operations: res.operations.map(o => ({ ...o, logref: "", operationRunCommand: {} })) };
        };
        nr.send("logs", { payload: commandOp.id });
        assert.match((await caught.next()).error.message, /has no logs/);
    });

    it("completes the message when the log has been streamed", async function () {
        await nr.load(flow({ source: "operation", operationValue: "payload", operationType: "msg" }), server);
        const out = nr.collect("out");
        const completed = nr.collect("completed");
        nr.send("logs", { payload: commandOp.id, _id: "m1" });
        await completed.next(m => m._id === "m1");
        assert.ok(out.messages.some(isCommandOutput), "output arrived before completion");
    });

    it("sends unknown operations to Catch nodes", async function () {
        await nr.load(flow({ source: "operation", operationValue: "payload", operationType: "msg" }), server);
        const caught = nr.collect("caught");
        nr.send("logs", { payload: "999999" });
        const msg = await caught.next();
        assert.match(msg.error.message, /Operation 999999 not found/);
    });

    it("stops a running stream without reporting an error", async function () {
        // A backup's log stays open while the backup runs; stop it straight away.
        await nr.load(flow({ source: "logref", logRefValue: "logRef", logRefType: "msg", triggerValue: "listen", triggerType: "msg" }), server);
        const caught = nr.collect("caught");
        const completed = nr.collect("completed");
        nr.send("logs", { listen: true, logRef: commandOp.operationRunCommand.outputLogref, _id: "start" });
        nr.send("logs", { listen: false, _id: "stop" });
        await completed.next(m => m._id === "stop");
        await new Promise(r => setTimeout(r, 500));
        assert.strictEqual(caught.messages.length, 0, caught.messages.map(m => m.error.message).join());
    });
});
