// HTTP requests to the Backrest JSON API.
const https = require("https");
const axios = require("axios");

/**
 * Connection settings for a Backrest server:
 * { url, username, password, tlsOptions } where tlsOptions come from a tls-config node.
 */
function httpsAgentFor(tlsOptions) {
    return tlsOptions ? new https.Agent(tlsOptions) : undefined;
}

function requestOptions(server) {
    return {
        headers: { "Content-Type": "application/json" },
        auth: (server.username && server.password) ? { username: server.username, password: server.password } : undefined,
        httpsAgent: server.httpsAgent
    };
}

/**
 * Call a Backrest API method (such as "GetConfig") and resolve with the response body.
 * Errors include Backrest's own error message when there is one.
 */
async function request(server, method, body = {}) {
    if (!server.url) {
        throw new Error("No Backrest URL configured");
    }
    try {
        const res = await axios.post(`${server.url}/v1.Backrest/${method}`, body, requestOptions(server));
        return res.data;
    } catch (err) {
        const data = err.response && err.response.data;
        const detail = data && typeof data === "object" && data.message ? data.message
            : typeof data === "string" && data ? data.trim() : err.message;
        const status = err.response ? ` (${err.response.status})` : "";
        const wrapped = new Error(`Backrest ${method} failed${status}: ${detail}`);
        wrapped.status = err.response && err.response.status;
        wrapped.code = data && data.code;
        throw wrapped;
    }
}

module.exports = { httpsAgentFor, requestOptions, request };
