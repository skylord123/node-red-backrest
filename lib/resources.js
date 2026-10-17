// Lists of plans, repositories and operations for the editor's pickers.
const client = require("./client");
const { operationType, num } = require("./operations");

const MAX_OPERATIONS = 100;

async function listResources(server, include = ["plans", "repos"]) {
    const result = {};
    if (include.includes("plans") || include.includes("repos")) {
        const config = await client.request(server, "GetConfig");
        result.instance = config.instance;
        if (include.includes("plans")) {
            result.plans = (config.plans || []).map(p => ({ id: p.id, repo: p.repo, paths: p.paths || [] }));
        }
        if (include.includes("repos")) {
            result.repos = (config.repos || []).map(r => ({ id: r.id, guid: r.guid, uri: r.uri }));
        }
    }
    if (include.includes("operations")) {
        const res = await client.request(server, "GetOperations", { selector: {}, lastN: MAX_OPERATIONS });
        result.operations = (res.operations || [])
            .map(op => ({
                id: op.id,
                type: operationType(op),
                planId: op.planId,
                repoId: op.repoId,
                status: op.status,
                time: num(op.unixTimeStartMs)
            }))
            .reverse(); // newest first
    }
    return result;
}

module.exports = { listResources, MAX_OPERATIONS };
