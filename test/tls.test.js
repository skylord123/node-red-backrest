const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getBackrest } = require("./fixtures/backrest");
const nr = require("./fixtures/nodered");

describe("HTTPS Backrest URLs", function () {
    let server, caFile;

    before(async function () {
        server = await getBackrest();
        await server.startTlsProxy();
        caFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nrb-ca-")), "root.crt");
        fs.writeFileSync(caFile, server.tlsCa);
        nr.withNodes(
            nr.coreNode("network/05-tls.js"),
            nr.coreNode("common/25-catch.js")
        );
    });

    after(function () {
        nr.withNodes();
    });

    function flow(tls) {
        return [
            { id: "f1", type: "tab" },
            { id: "tls1", type: "tls-config", certType: "files", cert: "", key: "", ca: "", servername: "", ...tls },
            { id: "cfg", type: "backrest-config", name: "https server", tls: "tls1", autoReconnect: true, reconnectInterval: "500" },
            {
                id: "api", type: "backrest-api", z: "f1", config: "cfg", endpoint: "/v1.Backrest/GetConfig",
                inputType: "msg", inputValue: "payload", outputType: "msg", outputValue: "payload", wires: [["out"]]
            },
            { id: "events", type: "backrest-operation-events", z: "f1", config: "cfg", mode: "always", wires: [["events-out"]] },
            {
                id: "logs", type: "backrest-get-logs", z: "f1", config: "cfg",
                triggerValue: "true", triggerType: "bool", logRefValue: "logRef", logRefType: "msg", wires: [["logs-out"]]
            },
            { id: "out", type: "helper", z: "f1" },
            { id: "events-out", type: "helper", z: "f1" },
            { id: "logs-out", type: "helper", z: "f1" },
            ...nr.catchNodes()
        ];
    }

    function creds() {
        return { cfg: { backrest_url: server.tlsUrl, username: server.username, password: server.password } };
    }

    async function checkAllNodes() {
        const out = nr.collect("out");
        const events = nr.collect("events-out");
        const logs = nr.collect("logs-out");

        nr.send("api", { payload: {} });
        assert.strictEqual((await out.next()).payload.instance, "nrtest");

        await new Promise(r => setTimeout(r, 500));
        const { operationId } = await server.raw("RunCommand", { repoId: "test-repo", command: "version" });
        await events.next(m => JSON.stringify(m.payload).includes(`"${operationId}"`));

        const op = await server.waitForOperation(operationId);
        nr.send("logs", { logRef: op.operationRunCommand.outputLogref });
        await logs.next(m => /restic version/.test(String(m.payload)));
    }

    it("works with a TLS config that trusts the CA", async function () {
        await nr.load(flow({ ca: caFile, verifyservercert: true }), server, creds());
        await checkAllNodes();
    });

    it("works with certificate verification turned off", async function () {
        await nr.load(flow({ verifyservercert: false }), server, creds());
        await checkAllNodes();
    });

    it("rejects an untrusted certificate", async function () {
        await nr.load(flow({ verifyservercert: true }), server, creds());
        const caught = nr.collect("caught");
        nr.send("api", { payload: {} });
        const msg = await caught.next();
        assert.match(msg.error.message, /certificate/);
    });
});
