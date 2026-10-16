const assert = require("assert");
const { getBackrest } = require("./fixtures/backrest");
const nr = require("./fixtures/nodered");

describe("Editor resources endpoint", function () {
    let server;

    before(async function () {
        server = await getBackrest();
    });

    beforeEach(async function () {
        await nr.load([{ id: "cfg", type: "backrest-config", name: "test" }], server);
    });

    function post(body) {
        return nr.helper.request().post("/backrest/resources").send(body);
    }

    it("lists plans and repositories of a deployed config", async function () {
        const res = await post({ config: "cfg" }).expect(200);
        assert.ok(res.body.plans.some(p => p.id === "test-plan" && p.repo === "test-repo"));
        assert.ok(res.body.repos.some(r => r.id === "test-repo" && r.guid === server.repoGuid));
        assert.strictEqual(res.body.operations, undefined);
    });

    it("lists recent operations, newest first", async function () {
        await server.raw("Backup", { value: "test-plan", dryRun: true });
        const res = await post({ config: "cfg", include: ["operations"] }).expect(200);
        const ops = res.body.operations;
        assert.ok(ops.length > 0);
        assert.ok(Number(ops[0].id) > Number(ops[ops.length - 1].id) || ops.length === 1);
        assert.ok(ops.some(o => o.type === "backup" && o.planId === "test-plan"));
    });

    it("uses unsaved settings from the editor, keeping the deployed password", async function () {
        const res = await post({ config: "cfg", url: server.url, username: server.username, password: "__PWRD__" }).expect(200);
        assert.ok(res.body.plans.length > 0);
    });

    it("works for a config node that hasn't been deployed", async function () {
        const res = await post({ config: "new-node", url: server.url, username: server.username, password: server.password }).expect(200);
        assert.ok(res.body.plans.length > 0);
        await post({ config: "new-node" }).expect(400);
    });

    it("reports Backrest errors", async function () {
        const res = await post({ config: "new-node", url: server.url, username: "admin", password: "wrong" }).expect(502);
        assert.match(res.body.error, /401/);
    });
});
