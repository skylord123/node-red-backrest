const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path = require("path");

// Defaults for reconnect logic
const DEFAULT_RECONNECT_INTERVAL = 1000;
const DEFAULT_MAX_RECONNECT_TRIES = 0;

// gRPC error codes
const ERROR_CODES = {
    CANCELLED: 1,
    UNKNOWN: 2,
    DEADLINE_EXCEEDED: 4,
    UNAVAILABLE: 14
};

module.exports = function(RED) {
    // In-memory cache so we load proto only once
    let protoDescriptor = null;
    function loadProtoDefinitions() {
        if (protoDescriptor) return protoDescriptor;
        const PROTO_PATH = path.join(__dirname, "proto", "v1", "service.proto");
        const packageDef = protoLoader.loadSync(PROTO_PATH, {
            keepCase: true,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
            includeDirs: [path.join(__dirname, "proto")]
        });
        protoDescriptor = grpc.loadPackageDefinition(packageDef);
        return protoDescriptor;
    }

    /**
     * Utility: Strip http:// or https:// from the URL for gRPC usage.
     */
    function stripHttpPrefix(urlString) {
        if (!urlString) return "";
        return urlString.replace(/^https?:\/\//, "");
    }

    /**
     * Utility: Create Basic Auth metadata if username/password exist.
     */
    function createAuthMetadata(username, password) {
        const metadata = new grpc.Metadata();
        if (username && password) {
            const authString = Buffer.from(`${username}:${password}`).toString("base64");
            metadata.add("Authorization", `Basic ${authString}`);
        }
        return metadata;
    }

    function BackrestConfigNode(config) {
        RED.nodes.createNode(this, config);

        // Exposed in the UI
        this.autoReconnect = config.autoReconnect || false;
        this.reconnectInterval = parseInt(config.reconnectInterval) || DEFAULT_RECONNECT_INTERVAL;
        this.maxReconnectTries = parseInt(config.reconnectTries) || DEFAULT_MAX_RECONNECT_TRIES;

        // Credentials
        if (this.credentials) {
            this.backrest_url = (this.credentials.backrest_url || "").replace(/\/?$/, "");
            this.username = this.credentials.username || "";
            this.password = this.credentials.password || "";
        } else {
            this.backrest_url = "";
            this.username = "";
            this.password = "";
        }

        // gRPC client + streaming state
        this.client = null;
        this.operationStreamCall = null;  // active call for GetOperationEvents
        this.operationStreamEndOrErrorHandled = false;
        this.subscribers = [];            // array of { node, callback } objects
        this.reconnectAttempts = 0;
        this.manualStop = false;

        // Create the gRPC client (insecure in this example)
        this.setupClient();

        // When this config node is closed, stop the stream.
        this.on("close", () => {
            this.stopOperationEventsStream();
        });
    }

    /**
     * Set up the gRPC client (insecure example). For TLS, replace createInsecure with createSsl.
     */
    BackrestConfigNode.prototype.setupClient = function() {
        const proto = loadProtoDefinitions();
        const backrestPackage = proto.v1;
        if (!backrestPackage || !backrestPackage.Backrest) {
            this.error("Could not load the Backrest service from proto definitions.");
            return;
        }
        const grpcTarget = stripHttpPrefix(this.backrest_url);
        this.log(`Creating gRPC client for Backrest at: ${grpcTarget}`);

        this.client = new backrestPackage.Backrest(
            grpcTarget,
            grpc.credentials.createInsecure()
        );
    };

    /**
     * Update status on all subscribed OperationEvents nodes.
     */
    BackrestConfigNode.prototype.updateSubscribersStatus = function() {
        let statusObj;
        if (this.operationStreamCall) {
            statusObj = { fill: "green", shape: "dot", text: "subscribed" };
        } else {
            statusObj = {
                fill: "red",
                shape: "dot",
                text: `disconnected, reconnecting in ${this.reconnectInterval}ms` +
                    (this.maxReconnectTries !== 0 ? ` (${this.reconnectAttempts}/${this.maxReconnectTries})` : '')
            };
        }
        this.subscribers.forEach(sub => {
            sub.node.status(statusObj);
        });
    };

    /**
     * Start the single OperationEvents stream, if not already started.
     */
    BackrestConfigNode.prototype.startOperationEventsStream = function() {
        if (this.operationStreamCall) {
            this.log("OperationEvents stream already active; ignoring start request.");
            return;
        }
        if (!this.client) {
            this.error("No gRPC client available; cannot start OperationEvents stream.");
            return;
        }

        this.log("Starting OperationEvents stream...");
        this.manualStop = false;
        this.operationStreamEndOrErrorHandled = false;

        // Build metadata
        const metadata = createAuthMetadata(this.username, this.password);

        // Start the call
        this.operationStreamCall = this.client.GetOperationEvents({}, metadata);

        // Wire up events
        this.operationStreamCall.on("data", (data) => {
            // If we receive data, the connection is working;
            // reset reconnectAttempts if needed.
            if (this.reconnectAttempts > 0) {
                this.reconnectAttempts = 0;
                this.updateSubscribersStatus();
            }
            // Broadcast to all subscribers.
            for (const sub of this.subscribers) {
                sub.callback(data);
            }
        });

        this.operationStreamCall.on("error", (err) => {
            if (this.operationStreamEndOrErrorHandled) return;
            this.operationStreamEndOrErrorHandled = true;
            this.operationStreamCall = null;
            this.handleOperationStreamError(err);
        });

        this.operationStreamCall.on("end", () => {
            if (this.operationStreamEndOrErrorHandled) return;
            this.operationStreamEndOrErrorHandled = true;
            this.log("OperationEvents stream ended.");
            this.operationStreamCall = null;
            this.maybeReconnect();
        });

        // Do not reset reconnectAttempts here; only reset on receiving data.
        this.updateSubscribersStatus();
    };

    /**
     * Stop the OperationEvents stream, if active.
     */
    BackrestConfigNode.prototype.stopOperationEventsStream = function() {
        if (this.operationStreamCall) {
            this.log("Stopping OperationEvents stream...");
            this.manualStop = true;
            this.operationStreamCall.cancel();
            this.operationStreamCall = null;
        }
        // Do not reset reconnectAttempts here since they persist until a successful connection.
        this.subscribers.forEach(sub => {
            sub.node.status({ fill: "yellow", shape: "ring", text: "not subscribed" });
        });
    };

    /**
     * Handle stream error (or unexpected end) and possibly trigger a reconnect.
     */
    BackrestConfigNode.prototype.handleOperationStreamError = function(err) {
        if (err.code === ERROR_CODES.CANCELLED && err.details === "Cancelled on client") {
            this.log("OperationEvents stream cancelled by client (manual stop).");
            return;
        }
        switch (err.code) {
            case ERROR_CODES.DEADLINE_EXCEEDED:
                this.error("OperationEvents stream timed out.");
                break;
            case ERROR_CODES.UNAVAILABLE:
                this.error("OperationEvents stream: server unavailable.");
                break;
            default:
                this.error(`OperationEvents stream error: ${err.message}`);
                break;
        }
        this.maybeReconnect();
    };

    /**
     * Attempt reconnect if autoReconnect is enabled and there are subscribers.
     * Note: The reconnectAttempts counter is only incremented on each failed attempt and
     * is reset when we successfully receive data.
     */
    BackrestConfigNode.prototype.maybeReconnect = function() {
        if (this.manualStop) {
            this.log("Not reconnecting: manual stop triggered.");
            return;
        }
        if (!this.autoReconnect) {
            this.log("Not reconnecting: autoReconnect is disabled.");
            return;
        }
        if (this.subscribers.length === 0) {
            this.log("Not reconnecting: no subscribers.");
            return;
        }
        if (this.maxReconnectTries !== 0 && this.reconnectAttempts >= this.maxReconnectTries) {
            this.error(`Max reconnect attempts (${this.maxReconnectTries}) reached; giving up.`);
            this.updateSubscribersStatus();
            return;
        }
        this.reconnectAttempts++;
        this.log(`Reconnecting OperationEvents stream (attempt #${this.reconnectAttempts}) in ${this.reconnectInterval}ms...`);
        this.updateSubscribersStatus();
        setTimeout(() => {
            this.startOperationEventsStream();
        }, this.reconnectInterval);
    };

    /**
     * Subscribe a node to the OperationEvents stream. Provide a callback for receiving data.
     */
    BackrestConfigNode.prototype.subscribeOperationEvents = function(node, callback) {
        const existing = this.subscribers.find(s => s.node.id === node.id);
        if (!existing) {
            this.log(`Node ${node.id} subscribed to OperationEvents.`);
            this.subscribers.push({ node, callback });
        }
        if (!this.operationStreamCall) {
            this.startOperationEventsStream();
        } else {
            node.status({ fill: "green", shape: "dot", text: "subscribed" });
        }
    };

    /**
     * Unsubscribe a node from the OperationEvents stream. If no subscribers remain, stop the stream.
     */
    BackrestConfigNode.prototype.unsubscribeOperationEvents = function(node) {
        const idx = this.subscribers.findIndex(s => s.node.id === node.id);
        if (idx !== -1) {
            this.log(`Node ${node.id} unsubscribing from OperationEvents.`);
            this.subscribers[idx].node.status({ fill: "yellow", shape: "ring", text: "not subscribed" });
            this.subscribers.splice(idx, 1);
        }
        if (this.subscribers.length === 0) {
            this.stopOperationEventsStream();
        }
    };

    RED.nodes.registerType("backrest-config", BackrestConfigNode, {
        credentials: {
            backrest_url: { type: "text" },
            username: { type: "text" },
            password: { type: "password" }
        }
    });
};
