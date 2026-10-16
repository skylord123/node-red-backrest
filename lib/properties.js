// Resolving typed-input properties, including the Backrest picker types added by
// resources/backrest-editor.js ("backrest-plan", "backrest-repo", "backrest-operation"
// hold the selected ID; "backrest-any" means no value).

const PICKER_TYPES = new Set(["backrest-plan", "backrest-repo", "backrest-operation"]);

/** Evaluate a typed-input property, resolving to its value (undefined for "backrest-any"). */
function evaluate(RED, node, value, type, msg) {
    if (type === "backrest-any") return Promise.resolve(undefined);
    if (PICKER_TYPES.has(type)) return Promise.resolve(value);
    return new Promise((resolve, reject) => {
        RED.util.evaluateNodeProperty(value, type, node, msg, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

/** Evaluate to a non-empty string ID, or throw an error naming the property. */
async function evaluateId(RED, node, value, type, msg, what) {
    const result = await evaluate(RED, node, value, type, msg);
    if (result === undefined || result === null || result === "") {
        throw new Error(`No ${what} given`);
    }
    if (typeof result === "object") {
        // An operation object, or a Run Backup result ({ operationId, ... })
        if (result.id !== undefined) return String(result.id);
        if (result.operationId !== undefined) return String(result.operationId);
        throw new Error(`Expected a ${what} ID but got an object`);
    }
    return String(result);
}

module.exports = { evaluate, evaluateId, PICKER_TYPES };
