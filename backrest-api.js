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
            "/v1.Backrest/SetConfig": {
                description: "Update the Backrest server configuration.",
                input: {
                    type: "object",
                    example: {
                        key: "value" // Replace with the actual configuration format
                    }
                },
                output: {
                    type: "object",
                    description: "The updated configuration object."
                }
            },
            "/v1.Backrest/CheckRepoExists": {
                description: "Check if a repository exists on the Backrest server.",
                input: {
                    type: "object",
                    example: {
                        id: "repo-id" // Repository identifier
                    }
                },
                output: {
                    type: "boolean",
                    description: "Returns true if the repository exists, false otherwise."
                }
            },
            "/v1.Backrest/AddRepo": {
                description: "Add a new repository to the Backrest server.",
                input: {
                    type: "object",
                    example: {
                        id: "repo-id", // Repository identifier
                        path: "/path/to/repo" // Repository path
                    }
                },
                output: {
                    type: "object",
                    description: "The updated configuration object including the new repository."
                }
            },
            "/v1.Backrest/GetOperationEvents": {
                description: "Stream real-time operation changes (created, updated, or deleted).",
                input: {
                    type: "none",
                    example: null // No input required
                },
                output: {
                    type: "stream",
                    description: "A stream of operation events (created, updated, deleted)."
                }
            },
            "/v1.Backrest/ListSnapshots": {
                description: "List snapshots for a repository or plan.",
                input: {
                    type: "object",
                    example: {
                        repoId: "repo-id", // Repository identifier
                        planId: "plan-id"  // Plan identifier (optional)
                    }
                },
                output: {
                    type: "array",
                    description: "Array of snapshots with metadata (e.g., ID, paths, tags)."
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
            },
            "/v1.Backrest/Backup": {
                description: "Schedule a backup operation.",
                input: {
                    type: "object",
                    example: {
                        value: "plan-id" // Plan identifier
                    }
                },
                output: {
                    type: "none",
                    description: "No response body, indicates the operation was successfully enqueued."
                }
            },
            "/v1.Backrest/DoRepoTask": {
                description: "Schedule a repository task (e.g., prune, stats).",
                input: {
                    type: "object",
                    example: {
                        repoId: "repo-id", // Repository identifier
                        task: "TASK_PRUNE" // Task type (e.g., TASK_PRUNE, TASK_CHECK)
                    }
                },
                output: {
                    type: "none",
                    description: "No response body, indicates the task was successfully enqueued."
                }
            },
            "/v1.Backrest/Forget": {
                description: "Schedule a forget operation to clean up snapshots.",
                input: {
                    type: "object",
                    example: {
                        repoId: "repo-id",  // Repository identifier
                        planId: "plan-id",  // Plan identifier
                        snapshotId: "snap-id" // Specific snapshot to forget (optional)
                    }
                },
                output: {
                    type: "none",
                    description: "No response body, indicates the operation was successfully enqueued."
                }
            },
            "/v1.Backrest/Restore": {
                description: "Schedule a restore operation for a snapshot.",
                input: {
                    type: "object",
                    example: {
                        planId: "plan-id",       // Plan identifier
                        repoId: "repo-id",       // Repository identifier
                        snapshotId: "snapshot-id", // Snapshot to restore
                        path: "/source/path",    // Source path in the snapshot (optional)
                        target: "/restore/path"  // Target restore path (optional)
                    }
                },
                output: {
                    type: "none",
                    description: "No response body, indicates the operation was successfully enqueued."
                }
            },
            "/v1.Backrest/Cancel": {
                description: "Attempt to cancel an operation by its ID.",
                input: {
                    type: "object",
                    example: {
                        value: 12345 // Operation ID
                    }
                },
                output: {
                    type: "none",
                    description: "No response body, indicates the cancellation request was submitted."
                }
            },
            "/v1.Backrest/GetLogs": {
                description: "Stream logs for a specific operation.",
                input: {
                    type: "object",
                    example: {
                        ref: "operation-ref" // Operation reference
                    }
                },
                output: {
                    type: "stream",
                    description: "Stream of log data for the specified operation."
                }
            },
            "/v1.Backrest/RunCommand": {
                description: "Execute a custom Restic command on a repository.",
                input: {
                    type: "object",
                    example: {
                        repoId: "repo-id",  // Repository identifier
                        command: "restic-command" // Command to execute
                    }
                },
                output: {
                    type: "object",
                    description: "Operation ID of the submitted command."
                }
            },
            "/v1.Backrest/GetDownloadURL": {
                description: "Retrieve a signed URL for downloading forget operation results.",
                input: {
                    type: "object",
                    example: {
                        value: 12345 // Forget operation ID
                    }
                },
                output: {
                    type: "object",
                    description: "Signed URL for downloading the results."
                }
            },
            "/v1.Backrest/ClearHistory": {
                description: "Clear operation history on the server.",
                input: {
                    type: "object",
                    example: {
                        selector: { planId: "plan-id" }, // Filter for operations to clear (optional)
                        onlyFailed: true // Clear only failed operations (optional)
                    }
                },
                output: {
                    type: "none",
                    description: "No response body, indicates the history was successfully cleared."
                }
            },
            "/v1.Backrest/PathAutocomplete": {
                description: "Provide path autocomplete suggestions for a given path.",
                input: {
                    type: "object",
                    example: {
                        value: "/base/path" // Path to autocomplete
                    }
                },
                output: {
                    type: "array",
                    description: "List of autocomplete suggestions."
                }
            },
            "/v1.Backrest/GetSummaryDashboard": {
                description: "Retrieve summary data for the dashboard view.",
                input: {
                    type: "none",
                    example: null // No input required
                },
                output: {
                    type: "object",
                    description: "Summary metrics and statistics for the dashboard."
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
                        const errorDetails = {
                            status: error.response?.status || 'N/A',
                            data: error.response?.data ? JSON.stringify(error.response.data) : 'No response data',
                            message: error.message || 'Unknown error'
                        };
                        node.error(`Request failed - ${JSON.stringify(errorDetails)}`);
                        if (done) done(error);
                    });
            };

            RED.util.evaluateNodeProperty(config.inputValue, config.inputType, node, msg, processInput);
        });
    }

    RED.nodes.registerType('backrest-api', BackrestQueryNode, {
        credentials: {
            username: { type: 'text' },
            password: { type: 'password' }
        }
    });
};
