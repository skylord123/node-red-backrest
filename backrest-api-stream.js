const path = require("path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const DEFAULT_RECONNECT_INTERVAL = 5000;
const DEFAULT_MAX_RECONNECT_TRIES = 5;
const ERROR_CODES = {
    CANCELLED: 1,
    UNKNOWN: 2,
    DEADLINE_EXCEEDED: 4,
    UNAVAILABLE: 14
};

let protoDescriptor = null;

/**
 * Strip http:// or https:// prefix so we have a proper gRPC target (host:port).
 */
function stripHttpPrefix(urlString) {
    if (!urlString) return "";
    return urlString.replace(/^https?:\/\//, "");
}

/**
 * Load proto definitions once and cache them
 */
function loadProtoDefinitions(node) {
    if (protoDescriptor) {
        node.debug("Proto definitions already loaded.");
        return protoDescriptor;
    }
    node.debug("Loading proto definitions for the first time...");

    const PROTO_PATH = path.join(__dirname, "proto", "v1", "service.proto");
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [path.join(__dirname, "proto")]
    });

    protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    return protoDescriptor;
}

/**
 * Create gRPC metadata for Basic Auth, if credentials exist
 */
function createAuthMetadata(username, password) {
    const metadata = new grpc.Metadata();
    if (username && password) {
        const authString = Buffer.from(`${username}:${password}`).toString("base64");
        metadata.add("Authorization", `Basic ${authString}`); // capital A
    }
    return metadata;
}

/**
 * Handle stream error. Returns true if we should attempt reconnect.
 */
function handleStreamError(err, node, state) {
    node.debug(`handleStreamError invoked: code ${err.code}, details: ${err.details}`);

    // Ignore "Cancelled on client" if we manually stopped
    if (err.code === ERROR_CODES.CANCELLED && err.details === "Cancelled on client") {
        node.status({ fill: "red", shape: "ring", text: "stream stopped" });
        return false;
    }

    switch (err.code) {
        case ERROR_CODES.DEADLINE_EXCEEDED:
            node.error("Stream timeout - server not responding");
            node.status({ fill: "red", shape: "dot", text: "timeout" });
            break;
        case ERROR_CODES.UNAVAILABLE:
            node.error("Server unavailable - check connection");
            node.status({ fill: "red", shape: "dot", text: "server down" });
            break;
        default:
            node.error(`Stream error: ${err.message || err}`);
            node.status({ fill: "red", shape: "dot", text: "error" });
    }

    state.activeCall = null;
    // Only reconnect on GetOperationEvents if autoReconnect is true
    return !state.manualStop && state.method === "GetOperationEvents";
}

/**
 * Forward streaming data to Node-RED messages
 */
function processStreamData(data, method, node) {
    if (method === "GetLogs") {
        const logString = data.value.toString("utf8");
        try {
            const jsonData = JSON.parse(logString);
            node.send({ payload: jsonData });
        } catch (err) {
            node.send({ payload: logString });
        }
    } else {
        node.send({ payload: data });
    }
}

module.exports = function (RED) {
    class BackrestStreamNode {
        constructor(config) {
            RED.nodes.createNode(this, config);
            this.debug("Constructing backrest-api-stream node...");

            // State for managing connection and reconnect
            this.state = {
                activeCall: null,
                reconnectAttempts: 0,
                manualStop: false,
                method: config.streamMethod || "GetLogs",
                autoReconnect: config.autoReconnect || false,
                reconnectInterval: parseInt(config.reconnectInterval) || DEFAULT_RECONNECT_INTERVAL,
                maxReconnectTries: parseInt(config.reconnectTries) || DEFAULT_MAX_RECONNECT_TRIES
            };

            // Config node with server info
            this.serverConfig = RED.nodes.getNode(config.config);
            if (!this.serverConfig) {
                this.error("No Backrest server configuration found");
                this.status({ fill: "red", shape: "dot", text: "no config" });
                return;
            }

            // Setup the gRPC client (insecure channel) — no connect yet
            this.setupClient();

            // Setup how we respond to messages and node closure
            this.setupEventHandlers(config);

            // Start "disconnected"
            this.status({ fill: "red", shape: "ring", text: "disconnected" });
        }

        /**
         * Create the gRPC client using an insecure channel.
         * We apply Basic Auth metadata per call (not at channel level).
         */
        setupClient() {
            const proto = loadProtoDefinitions(this);
            const backrestPackage = proto.v1;
            if (!backrestPackage?.Backrest) {
                this.error("Could not load the Backrest service from proto definitions.");
                this.status({ fill: "red", shape: "dot", text: "proto load error" });
                return;
            }

            const rawUrl = this.serverConfig.backrest_url.trim();
            let creds;
            let grpcTarget = stripHttpPrefix(rawUrl); // remove http://
            this.debug(`Using gRPC target: ${grpcTarget}`);

            if (rawUrl.startsWith("https://")) {
                // Strip https:// and use createSsl
                grpcTarget = rawUrl.replace(/^https?:\/\//, "");
                creds = grpc.credentials.createSsl();
            } else {
                // Strip http:// and use insecure
                grpcTarget = rawUrl.replace(/^http?:\/\//, "");
                creds = grpc.credentials.createInsecure();
            }

            this.client = new backrestPackage.Backrest(
                grpcTarget,
                creds
            );

            this.debug("gRPC client created (insecure). Auth applied per call via metadata.");
        }

        /**
         * Listen for inbound messages (input) and node closure
         */
        setupEventHandlers(config) {
            this.on("input", (msg, send, done) => this.handleInput(msg, config, done));
            this.on("close", () => {
                this.debug("Node closed; stopping stream.");
                this.stopStream();
            });
        }

        /**
         * Stop any active stream
         */
        stopStream() {
            this.debug("stopStream() called.");
            this.state.manualStop = true;
            if (this.state.activeCall) {
                this.debug("Cancelling active gRPC call.");
                this.state.activeCall.cancel();
                this.state.activeCall = null;
            }
            this.status({ fill: "red", shape: "ring", text: "disconnected" });
        }

        /**
         * Start a gRPC streaming call (GetLogs or GetOperationEvents).
         * Basic Auth metadata is applied per call if username/password is set.
         */
        startStream(method, requestObj) {
            this.debug(`startStream() with method: ${method}, request: ${JSON.stringify(requestObj)}`);
            // Always stop any previous stream
            this.stopStream();
            this.state.manualStop = false;

            // Clear any previous end/error tracking for a new call
            this.state.endOrErrorHandled = false;

            this.status({ fill: "yellow", shape: "dot", text: "connecting..." });

            // Build metadata with credentials, if any
            const username = (this.serverConfig.credentials?.username || this.serverConfig.username) || "";
            const password = (this.serverConfig.credentials?.password || this.serverConfig.password) || "";
            const metadata = createAuthMetadata(username, password);

            if (!this.client) {
                this.error("No gRPC client available. Cannot start stream.");
                this.status({ fill: "red", shape: "dot", text: "no client" });
                return;
            }

            switch (method) {
                case "GetLogs":
                    this.state.activeCall = this.client.GetLogs(requestObj, metadata);
                    break;
                case "GetOperationEvents":
                    this.state.activeCall = this.client.GetOperationEvents(requestObj, metadata);
                    break;
                default:
                    this.error(`Unknown streaming method: ${method}`);
                    this.status({ fill: "red", shape: "dot", text: "error: no method" });
                    return;
            }

            this.setupStreamEventHandlers(method, requestObj);
            this.status({ fill: "green", shape: "dot", text: "listening" });
        }

        /**
         * Wire up data/end/error for the activeCall
         */
        setupStreamEventHandlers(method, requestObj) {
            if (!this.state.activeCall) {
                this.warn("No activeCall after starting the stream. Possibly unreachable server.");
                return;
            }

            // If we get an error or end, we only want to handle it once.
            this.state.endOrErrorHandled = false;

            this.state.activeCall.on("data", (data) => {
                this.debug("Received data event from stream.");
                processStreamData(data, method, this);
            });

            this.state.activeCall.on("error", (err) => {
                this.debug(`Stream error event: ${err.message || err}`);
                // If we've already handled an end/error, do nothing.
                if (this.state.endOrErrorHandled) return;
                this.state.endOrErrorHandled = true;

                const shouldReconnect = handleStreamError(err, this, this.state);
                if (shouldReconnect) {
                    this.attemptReconnect(method, requestObj);
                }
            });

            this.state.activeCall.on("end", () => {
                this.debug("Stream ended (on 'end' event).");
                // If we've already handled an error, do not do more.
                if (this.state.endOrErrorHandled) return;
                this.state.endOrErrorHandled = true;

                this.status({ fill: "red", shape: "ring", text: "stream ended" });
                this.state.activeCall = null;

                // Attempt reconnect on a clean end if user wants auto-reconnect
                // and we're streaming operation events (like a push feed).
                if (this.state.autoReconnect && !this.state.manualStop && method === "GetOperationEvents") {
                    this.attemptReconnect(method, requestObj);
                }
            });
        }

        /**
         * If autoReconnect is enabled, attempt to reconnect up to maxReconnectTries
         */
        attemptReconnect(method, requestObj) {
            this.debug(`attemptReconnect() for method ${method}. Attempt #${this.state.reconnectAttempts + 1}`);
            const { maxReconnectTries, reconnectAttempts, reconnectInterval } = this.state;

            if (maxReconnectTries !== 0 && reconnectAttempts >= maxReconnectTries) {
                this.error(`Max reconnect attempts (${maxReconnectTries}) reached.`);
                this.status({ fill: "red", shape: "dot", text: "reconnect failed" });
                return;
            }

            this.state.reconnectAttempts++;
            this.status({
                fill: "yellow",
                shape: "dot",
                text: `reconnecting (${reconnectAttempts + 1}${maxReconnectTries === 0 ? "+" : "/" + maxReconnectTries})...`
            });

            setTimeout(() => {
                this.debug(`Reconnection attempt #${this.state.reconnectAttempts} for method ${method}`);
                this.startStream(method, requestObj);
            }, reconnectInterval);
        }

        /**
         * Handle incoming messages
         * Only start the stream if the user-specified listenValue evaluates to true
         */
        async handleInput(msg, config, done) {
            this.debug("handleInput() triggered by incoming message.");
            try {
                const shouldListen = await this.evaluateProperty(config.listenValue, config.listenType, msg);
                this.debug(`shouldListen => ${shouldListen}`);

                if (!shouldListen) {
                    this.debug("shouldListen is false; stopping any active stream.");
                    this.stopStream();
                    done();
                    return;
                }

                // If we do want to listen, decide which streaming method to start
                if (this.state.method === "GetLogs") {
                    // Evaluate required logRef
                    const logRef = await this.evaluateProperty(config.logRefValue, config.logRefType, msg);
                    if (!logRef) {
                        throw new Error("No log reference provided for GetLogs");
                    }
                    this.startStream("GetLogs", { ref: logRef });
                } else {
                    // Default to operation events
                    this.startStream("GetOperationEvents", {});
                }

                // Reset reconnect attempts each time we start fresh
                this.state.reconnectAttempts = 0;
                done();
            } catch (error) {
                this.error(`Input processing error: ${error.message}`);
                this.status({ fill: "red", shape: "dot", text: "input error" });
                done(error);
            }
        }

        /**
         * Evaluate Node-RED property (e.g., msg.payload, flow var, etc.) asynchronously
         */
        evaluateProperty(value, type, msg) {
            return new Promise((resolve, reject) => {
                RED.util.evaluateNodeProperty(value, type, this, msg, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
        }
    }

    RED.nodes.registerType("backrest-api-stream", BackrestStreamNode, {
        credentials: {
            username: { type: "text" },
            password: { type: "password" }
        }
    });
};
