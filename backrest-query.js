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

        const baseURL = `http://${serverConfig.host}:${serverConfig.port}`;
        const username = serverConfig.credentials.username || '';
        const password = serverConfig.credentials.password || '';

        // Predefined API endpoints with descriptions
        const apiMap = {
            "/v1.Backrest/GetOperations": {
                description: "Fetch the list of operations from the Backrest server.",
                input: {
                    type: "object",
                    example: {
                        lastN: 1000, // Number of recent operations requested
                        selector: { repoId: "repo-id" } // Repository identifier
                    },
                },
                output: {
                    type: "array",
                    description: "Array of operations with their details (e.g., type, status)."
                }
            },
            "/v1.Backrest/GetConfig": {
                description: "Retrieve the Backrest server configuration.",
                input: {
                    type: "none",
                    example: null // No input required
                },
                output: {
                    type: "object",
                    description: "The configuration object describing the Backrest setup."
                }
            },
            "/v1.Backrest/ListSnapshotFiles": {
                description: "List files within a snapshot at a specific path.",
                input: {
                    type: "object",
                    example: {
                        repoId: "repository-id",   // Repository identifier
                        snapshotId: "snapshot-id", // Snapshot identifier
                        path: "target/path"        // Path to list files for
                    }
                },
                output: {
                    type: "object",
                    description: "Returns the path queried and an array of file entries (name, type, size, etc.)."
                }
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

            const processInput = function (err, evaluatedInput) {
                if (err) {
                    node.error(`Input Evaluation Error: ${err.message}`);
                    if (done) done(err);
                    return;
                }

                let payload = evaluatedInput || {};

                if (apiConfig.input.type === "none") {
                    payload = {};
                }

                const headers = {
                    'Content-Type': 'application/json'
                };

                axios.post(
                    `${baseURL}${endpoint}`,
                    payload,
                    {
                        headers,
                        auth: (username && password) ? { username, password } : undefined
                    }
                )
                    .then(response => {
                        msg.payload = response.data;
                        send(msg);
                        if (done) done();
                    })
                    .catch(error => {
                        const status = error.response?.status || 'N/A';
                        const responseData = error.response?.data ? JSON.stringify(error.response.data) : 'No response data';
                        const errorMessage = error.message || 'Unknown error';

                        node.error(`Request failed - Status: ${status}, Response: ${responseData}, Message: ${errorMessage}`);
                        if (done) done(error);
                    });
            };

            RED.util.evaluateNodeProperty(config.inputValue, config.inputType, node, msg, processInput);
        });
    }

    RED.nodes.registerType('backrest-query', BackrestQueryNode, {
        credentials: {
            username: { type: 'text' },
            password: { type: 'password' }
        }
    });
};
