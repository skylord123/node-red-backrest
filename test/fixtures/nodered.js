// Helpers for running our nodes inside node-red-node-test-helper.
// Set NODE_RED_PATH to a Node-RED install to test against another version.
const path = require("path");
const helper = require("node-red-node-test-helper");
const NODE_RED = process.env.NODE_RED_PATH ? path.resolve(process.env.NODE_RED_PATH) : path.dirname(require.resolve("node-red/package.json"));
helper.init(require.resolve(NODE_RED));

/** A core node module (such as "common/25-catch.js") from the same Node-RED install. */
function coreNode(file) {
    const nodesDir = path.dirname(require.resolve("@node-red/nodes/package.json", { paths: [NODE_RED] }));
    return require(path.join(nodesDir, "core", file));
}

const NODES = [
    require("../../backrest-config.js"),
    require("../../backrest-api.js"),
    require("../../backrest-operation-events.js"),
    require("../../backrest-get-logs.js"),
    require("../../backrest-run-backup.js"),
    require("../../backrest-backup-status.js")
];

/**
 * Load a flow. `server` is the Backrest fixture; every node of type backrest-config
 * gets its credentials unless the flow already provides them.
 */
async function load(flow, server, credentials = {}) {
    const creds = { ...credentials };
    for (const n of flow) {
        if (n.type === "backrest-config" && !creds[n.id]) {
            creds[n.id] = { backrest_url: server.url, username: server.username, password: server.password };
        }
    }
    // Loading over an already loaded flow never completes, so always start clean.
    await helper.unload();
    await helper.load(NODES.concat(extraNodes), flow, creds);
}

let extraNodes = [];
/** Load additional node modules (such as core nodes) along with ours. */
function withNodes(...modules) {
    extraNodes = modules;
}

// The test helper gives `http in` nodes an Express app that isn't served anywhere.
// This module captures it on every load so tests can serve it themselves.
let httpNodeApp = null;
function captureHttpNode(RED) {
    httpNodeApp = RED.httpNode;
}

/**
 * Serve the `http in` routes of the loaded flow on an address Docker containers can
 * reach. Load the flow with withNodes(..., captureHttpNode) first. Returns { port, close() }.
 */
async function serveHttpNodes() {
    if (!httpNodeApp) throw new Error("captureHttpNode wasn't loaded");
    const app = httpNodeApp;
    const server = require("http").createServer((req, res) => app(req, res));
    await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
    return {
        port: server.address().port,
        close: () => new Promise(resolve => {
            server.closeAllConnections();
            server.close(() => resolve());
        })
    };
}

function getNode(id) {
    return helper.getNode(id);
}

/**
 * Collect messages arriving at a helper node. Returns an object with `messages`
 * and `next(predicate, timeoutMs)` which resolves with the first matching message.
 */
function collect(id) {
    const node = helper.getNode(id);
    const messages = [];
    const waiters = [];
    node.on("input", msg => {
        messages.push(msg);
        for (const w of waiters.slice()) {
            if (w.predicate(msg)) {
                waiters.splice(waiters.indexOf(w), 1);
                clearTimeout(w.timer);
                w.resolve(msg);
            }
        }
    });
    return {
        messages,
        next(predicate = () => true, timeoutMs = 20000) {
            const found = messages.find(predicate);
            if (found) return Promise.resolve(found);
            return new Promise((resolve, reject) => {
                const w = { predicate, resolve };
                w.timer = setTimeout(() => {
                    waiters.splice(waiters.indexOf(w), 1);
                    reject(new Error(`No matching message on ${id} within ${timeoutMs}ms (got ${messages.length})`));
                }, timeoutMs);
                waiters.push(w);
            });
        }
    };
}

/** Send a message into a node and wait for its done() to be called. */
function send(id, msg) {
    helper.getNode(id).receive(msg);
}

/** A catch node wired to a helper, for checking errors reach Catch nodes. */
function catchNodes(z = "f1") {
    return [
        { id: "catcher", type: "catch", z, scope: null, uncaught: false, wires: [["caught"]] },
        { id: "caught", type: "helper", z }
    ];
}

module.exports = { helper, load, withNodes, getNode, collect, send, catchNodes, coreNode, captureHttpNode, serveHttpNodes };
