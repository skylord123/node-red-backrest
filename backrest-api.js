const axios = require('axios');

module.exports = function (RED) {
    function BackrestQueryNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const serverConfig = RED.nodes.getNode(config.config);
        if (!serverConfig) {
            node.error("No Backrest server configuration found");
            return;
        }

        const baseURL = serverConfig.backrest_url || '';
        const username = serverConfig.credentials.username || '';
        const password = serverConfig.credentials.password || '';
        const outputType = config.outputType || "msg";
        const outputValue = config.outputValue || "payload";

        // Predefined API endpoints with descriptions
        const apiMap = {
            "/v1.Backrest/GetOperations": {
                description: "Fetch the list of operations from the Backrest server.",
                input: { type: "object", example: { lastN: 1000, selector: { repoId: "repo-id" } } },
                output: { type: "array", description: "Array of operations with details (type, status, etc.)." }
            },
            "/v1.Backrest/GetConfig": {
                description: "Retrieve the Backrest server configuration.",
                input: { type: "none", example: null },
                output: { type: "object", description: "The Backrest configuration object." }
            },
            "/v1.Backrest/SetConfig": {
                description: "Update the Backrest server configuration.",
                input: { type: "object", example: { key: "value" } },
                output: { type: "object", description: "The updated configuration object." }
            },
            "/v1.Backrest/CheckRepoExists": {
                description: "Check if a repository exists on the Backrest server.",
                input: { type: "object", example: { id: "repo-id" } },
                output: { type: "boolean", description: "True if the repository exists, false otherwise." }
            },
            "/v1.Backrest/AddRepo": {
                description: "Add a new repository to the Backrest server.",
                input: { type: "object", example: { id: "repo-id", path: "/path/to/repo" } },
                output: { type: "object", description: "Updated config object including the new repository." }
            },
            "/v1.Backrest/GetOperationEvents": {
                description: "Stream real-time operation events (created, updated, or deleted).",
                input: { type: "none", example: null },
                output: { type: "stream", description: "A stream of operation events." }
            },
            "/v1.Backrest/ListSnapshots": {
                description: "List snapshots for a repository or plan.",
                input: { type: "object", example: { repoId: "repo-id", planId: "plan-id" } },
                output: { type: "array", description: "Array of snapshots with metadata." }
            },
            "/v1.Backrest/ListSnapshotFiles": {
                description: "List files within a snapshot at a specific path.",
                input: { type: "object", example: { repoId: "repository-id", snapshotId: "snapshot-id", path: "target/path" } },
                output: { type: "object", description: "Contains the path and an array of file entries." }
            },
            "/v1.Backrest/Backup": {
                description: "Schedule a backup operation.",
                input: { type: "object", example: { value: "plan-id" } },
                output: { type: "none", description: "No response body, indicates successful queueing." }
            },
            "/v1.Backrest/DoRepoTask": {
                description: "Schedule a repository task (prune, stats, etc.).",
                input: { type: "object", example: { repoId: "repo-id", task: "TASK_PRUNE" } },
                output: { type: "none", description: "No response body, indicates successful queueing." }
            },
            "/v1.Backrest/Forget": {
                description: "Schedule a forget operation to clean up snapshots.",
                input: { type: "object", example: { repoId: "repo-id", planId: "plan-id", snapshotId: "snap-id" } },
                output: { type: "none", description: "No response body, indicates successful queueing." }
            },
            "/v1.Backrest/Restore": {
                description: "Schedule a restore operation for a snapshot.",
                input: { type: "object", example: { planId: "plan-id", repoId: "repo-id", snapshotId: "snapshot-id", path: "/source/path", target: "/restore/path" } },
                output: { type: "none", description: "No response body, indicates successful queueing." }
            },
            "/v1.Backrest/Cancel": {
                description: "Attempt to cancel an operation by its ID.",
                input: { type: "object", example: { value: 12345 } },
                output: { type: "none", description: "No response body, indicates cancellation request submitted." }
            },
            "/v1.Backrest/GetLogs": {
                description: "Stream logs for a specific operation.",
                input: { type: "object", example: { ref: "operation-ref" } },
                output: { type: "stream", description: "A stream of log data." }
            },
            "/v1.Backrest/RunCommand": {
                description: "Execute a custom Restic command on a repository.",
                input: { type: "object", example: { repoId: "repo-id", command: "restic-command" } },
                output: { type: "object", description: "Operation ID of the submitted command." }
            },
            "/v1.Backrest/GetDownloadURL": {
                description: "Retrieve a signed URL for downloading forget operation results.",
                input: { type: "object", example: { value: 12345 } },
                output: { type: "object", description: "Signed URL for downloading results." }
            },
            "/v1.Backrest/ClearHistory": {
                description: "Clear operation history on the server.",
                input: { type: "object", example: { selector: { planId: "plan-id" }, onlyFailed: true } },
                output: { type: "none", description: "No response body, indicates history cleared." }
            },
            "/v1.Backrest/PathAutocomplete": {
                description: "Provide path autocomplete suggestions for a given path.",
                input: { type: "object", example: { value: "/base/path" } },
                output: { type: "array", description: "List of autocomplete suggestions." }
            },
            "/v1.Backrest/GetSummaryDashboard": {
                description: "Retrieve summary data for the dashboard view.",
                input: { type: "none", example: null },
                output: { type: "object", description: "Summary metrics and stats for the dashboard." }
            }
        };

        node.on('input', function (msg, send, done) {
            const endpoint = config.endpoint || '/v1.Backrest/GetOperations';

            if (!apiMap[endpoint]) {
                node.error(`Unknown API endpoint: ${endpoint}`);
                if (done) done(new Error(`Unknown API endpoint: ${endpoint}`));
                return;
            }

            const apiConfig = apiMap[endpoint];

            // Evaluate input property
            RED.util.evaluateNodeProperty(config.inputValue, config.inputType, node, msg, (err, evaluatedInput) => {
                if (err) {
                    node.error(`Input Evaluation Error: ${err.message}`);
                    if (done) done(err);
                    return;
                }

                let payload = evaluatedInput || {};
                if (apiConfig.input.type === "none") {
                    // Force empty object if endpoint does not require input
                    payload = {};
                }

                const headers = { 'Content-Type': 'application/json' };
                const url = `${baseURL}${endpoint}`;

                axios.post(url, payload, {
                    headers,
                    auth: (username && password) ? { username, password } : undefined
                })
                    .then(response => {
                        // Decide where to store output based on outputType + outputValue
                        switch (outputType) {
                            case "flow":
                                node.context().flow.set(outputValue, response.data);
                                send(msg);
                                break;
                            case "global":
                                node.context().global.set(outputValue, response.data);
                                send(msg);
                                break;
                            case "msg":
                            default:
                                RED.util.setMessageProperty(msg, outputValue, response.data, true);
                                send(msg);
                                break;
                        }

                        if (done) done();
                    })
                    .catch(error => {
                        const errorDetails = {
                            status: error.response?.status || 'N/A',
                            url: url,
                            data: error.response?.data ? JSON.stringify(error.response.data) : 'No response data',
                            message: error.message || 'Unknown error'
                        };
                        node.error(`Request failed - ${JSON.stringify(errorDetails)}`);
                        if (done) done(error);
                    });
            });
        });
    }

    RED.nodes.registerType('backrest-api', BackrestQueryNode, {
        credentials: {
            username: { type: 'text' },
            password: { type: 'password' }
        }
    });
};
