// Runs the "Backrest Hooks" example against Backrest command hooks set up exactly as
// the example's comment node describes.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { getBackrest } = require("./fixtures/backrest");
const nr = require("./fixtures/nodered");

const example = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "examples", "Backrest Hooks.json"), "utf8"));
const byName = name => example.find(n => n.name === name);
const setup = example.find(n => n.type === "comment").info;
// The two hooks from the setup instructions: condition, error behavior and command.
const HOOKS = Array.from(setup.matchAll(/runs when `(\w+)`, Error Behavior `(\w+)`, command:\s*```\n([\s\S]+?)\n```/g))
    .map(m => ({ condition: m[1], onError: m[2], command: m[3] }));

describe("Backrest Hooks example", function () {
    it("describes a start and an end hook", function () {
        assert.deepStrictEqual(HOOKS.map(h => [h.condition, h.onError]), [
            ["CONDITION_SNAPSHOT_START", "ON_ERROR_CANCEL"],
            ["CONDITION_SNAPSHOT_END", "ON_ERROR_IGNORE"]
        ]);
    });

    let server, http;

    before(async function () {
        server = await getBackrest();
        nr.withNodes(
            nr.coreNode("network/21-httpin.js"),
            nr.coreNode("parsers/70-JSON.js"),
            nr.coreNode("function/10-function.js"),
            nr.coreNode("common/25-catch.js"),
            nr.coreNode("common/90-comment.js"),
            nr.captureHttpNode
        );
    });

    after(function () {
        nr.withNodes();
    });

    afterEach(async function () {
        if (http) await http.close();
        http = null;
    });

    /** Load the example (with optional code changes) and point a plan's hooks at it. */
    async function loadExample(planId, changes = {}) {
        const flow = [{ id: example[1].z, type: "tab" }].concat(JSON.parse(JSON.stringify(example)));
        // Record what reaches each function node.
        for (const n of flow) {
            if (n.type === "function") {
                if (changes[n.name]) n.func = changes[n.name];
                n.wires[0].push(`seen-${n.id}`);
                flow.push({ id: `seen-${n.id}`, type: "helper", z: n.z });
            }
        }
        await nr.load(flow, server);
        // Serve the example's http in nodes where the Backrest container can reach them.
        http = await nr.serveHttpNodes();
        await server.addPlan({
            id: planId, repo: "test-repo", paths: ["/source"],
            hooks: HOOKS.map(h => ({
                conditions: [h.condition],
                onError: h.onError,
                actionCommand: { command: h.command.replace("NODE-RED-HOST:1880", `host.docker.internal:${http.port}`) }
            }))
        });
        return {
            stop: nr.collect(`seen-${byName("Stop the service").id}`),
            resume: nr.collect(`seen-${byName("Start the service again").id}`),
            cancel: nr.collect(`seen-${byName("Cancel the backup").id}`)
        };
    }

    async function lastBackup(planId) {
        const res = await server.raw("GetOperations", { selector: { planId } });
        return res.operations.filter(o => o.operationBackup).pop();
    }

    it("runs the backup after Node-RED has prepared, and reports the result", async function () {
        const { stop, resume } = await loadExample("hooked-plan", {
            // Take a moment, like stopping a container would
            "Stop the service": "await new Promise(r => setTimeout(r, 2000));\n" + byName("Stop the service").func
        });
        const started = Date.now();
        await server.raw("Backup", { value: "hooked-plan" });
        const took = Date.now() - started;

        const before = (await stop.next()).payload;
        assert.deepStrictEqual(before, { event: "snapshot start", plan: "hooked-plan", repo: "test-repo", snapshotId: "", error: "" });
        assert.ok(took >= 2000, `backup waited for Node-RED (${took}ms)`);

        const after = (await resume.next()).payload;
        assert.strictEqual(after.event, "snapshot end");
        assert.strictEqual(after.error, "");
        const op = await lastBackup("hooked-plan");
        assert.strictEqual(op.status, "STATUS_SUCCESS");
        assert.strictEqual(after.snapshotId, op.snapshotId);
    });

    it("cancels the backup when Node-RED can't prepare", async function () {
        const { stop, resume, cancel } = await loadExample("hooked-fail", {
            "Stop the service": "throw new Error('container would not stop');"
        });
        await assert.rejects(server.raw("Backup", { value: "hooked-fail" }));
        assert.match((await cancel.next()).payload, /container would not stop/);
        const op = await lastBackup("hooked-fail");
        assert.strictEqual(op.status, "STATUS_USER_CANCELLED");
        assert.ok(!op.snapshotId, "no snapshot");
        assert.strictEqual(stop.messages.length, 0);
        await new Promise(r => setTimeout(r, 500));
        assert.strictEqual(resume.messages.length, 0, "the end hook doesn't run for a cancelled backup");
    });

    it("cancels the backup when Node-RED can't be reached", async function () {
        await loadExample("hooked-offline");
        // Node-RED goes away: nothing listens on the hook URL any more.
        await http.close();
        http = null;
        await assert.rejects(server.raw("Backup", { value: "hooked-offline" }), err => {
            assert.match(err.response.data.message, /task cancelled: exit status 7/); // curl: couldn't connect
            return true;
        });
        const op = await lastBackup("hooked-offline");
        assert.strictEqual(op.status, "STATUS_USER_CANCELLED");
        assert.ok(!op.snapshotId, "no snapshot");
    });

    it("still runs the end flow when the backup fails", async function () {
        const { resume } = await loadExample("hooked-broken");
        await server.addPlan({
            ...(await server.raw("GetConfig")).plans.find(p => p.id === "hooked-broken"),
            paths: ["/does-not-exist"]
        });
        await assert.rejects(server.raw("Backup", { value: "hooked-broken" }));
        const after = (await resume.next()).payload;
        assert.strictEqual(after.event, "snapshot end");
        assert.match(after.error, /does-not-exist/);
        const op = await lastBackup("hooked-broken");
        assert.strictEqual(op.status, "STATUS_ERROR");
    });
});
