// Checks the example flows (no Backrest needed)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const pkg = require("../package.json");

const dir = path.join(__dirname, "..", "examples");
const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
const flows = Object.fromEntries(files.map(f => [f, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))]));

describe("Example flows", function () {
    it("has an example for every node", function () {
        const used = new Set(Object.values(flows).flat().map(n => n.type));
        for (const type of Object.keys(pkg["node-red"].nodes)) {
            if (type === "backrest-config") continue;
            assert.ok(used.has(type), `no example uses ${type}`);
        }
    });

    for (const [file, nodes] of Object.entries(flows)) {
        describe(file, function () {
            const ids = new Set(nodes.map(n => n.id));

            it("uses the shared Example server config", function () {
                const configs = nodes.filter(n => n.type === "backrest-config");
                assert.deepStrictEqual(configs.map(c => c.id), ["06bd2857df140cc4"]);
                assert.ok(!configs[0].credentials, "no credentials in examples");
                for (const n of nodes.filter(n => n.type.startsWith("backrest-") && n.type !== "backrest-config")) {
                    assert.strictEqual(n.config, configs[0].id, `${n.id} uses the shared config`);
                }
            });

            it("only wires to nodes in the same file", function () {
                for (const n of nodes) {
                    for (const port of n.wires || []) {
                        for (const target of port) assert.ok(ids.has(target), `${n.id} wires to missing ${target}`);
                    }
                    if (n.g) assert.ok(ids.has(n.g), `${n.id} is in missing group ${n.g}`);
                }
                for (const g of nodes.filter(n => n.type === "group")) {
                    for (const id of g.nodes) assert.ok(ids.has(id), `group ${g.name} lists missing ${id}`);
                }
            });

            it("has unique node IDs", function () {
                assert.strictEqual(ids.size, nodes.length);
            });
        });
    }

    it("doesn't reuse node IDs across examples (except the config)", function () {
        const seen = new Map();
        for (const [file, nodes] of Object.entries(flows)) {
            for (const n of nodes) {
                if (n.type === "backrest-config") continue;
                assert.ok(!seen.has(n.id), `${n.id} in both ${seen.get(n.id)} and ${file}`);
                seen.set(n.id, file);
            }
        }
    });
});
