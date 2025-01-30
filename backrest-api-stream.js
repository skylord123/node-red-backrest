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

function loadProtoDefinitions() {
    if (protoDescriptor) return protoDescriptor;

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

function handleStreamError(err, node, state) {
    // Ignore cancelled errors when manually stopping
    if (err.code === ERROR_CODES.CANCELLED && err.details === "Cancelled on client") {
        node.status({ fill: "red", shape: "ring", text: "stream stopped" });
        return false;
    }

    // Handle specific error cases
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
    return !state.manualStop && state.method === "GetOperationEvents";
}

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

            this.state = {
                activeCall: null,
                reconnectAttempts: 0,
                manualStop: false,
                method: config.streamMethod || "GetLogs",
                autoReconnect: config.autoReconnect || false,
                reconnectInterval: parseInt(config.reconnectInterval) || DEFAULT_RECONNECT_INTERVAL,
                maxReconnectTries: parseInt(config.reconnectTries) || DEFAULT_MAX_RECONNECT_TRIES
            };

            this.serverConfig = RED.nodes.getNode(config.config);
            if (!this.setupServer()) return;

            this.setupClient();
            this.setupEventHandlers(config);
            this.status({ fill: "red", shape: "ring", text: "disconnected" });
        }

        setupServer() {
            if (!this.serverConfig) {
                this.error("No Backrest server configuration found");
                this.status({ fill: "red", shape: "dot", text: "no config" });
                return false;
            }
            return true;
        }

        setupClient() {
            const protoDescriptor = loadProtoDefinitions();
            const backrestPackage = protoDescriptor.v1;

            if (!backrestPackage?.Backrest) {
                this.error("Could not load the Backrest service from proto definitions.");
                this.status({ fill: "red", shape: "dot", text: "proto load error" });
                return;
            }

            const target = `${this.serverConfig.host}:${this.serverConfig.port}`;
            this.client = new backrestPackage.Backrest(target, grpc.credentials.createInsecure());
        }

        setupEventHandlers(config) {
            this.on("input", (msg, send, done) => this.handleInput(msg, config, done));
            this.on("close", () => this.stopStream());
        }

        stopStream() {
            this.state.manualStop = true;
            if (this.state.activeCall) {
                this.state.activeCall.cancel();
                this.state.activeCall = null;
            }
            this.status({ fill: "red", shape: "ring", text: "disconnected" });
        }

        async startStream(method, requestObj) {
            this.stopStream();
            this.state.manualStop = false;
            this.status({ fill: "yellow", shape: "dot", text: "connecting..." });

            if (method === "GetLogs") {
                this.state.activeCall = this.client.GetLogs(requestObj);
            } else if (method === "GetOperationEvents") {
                this.state.activeCall = this.client.GetOperationEvents(requestObj);
            } else {
                this.error(`Unknown streaming method: ${method}`);
                this.status({ fill: "red", shape: "dot", text: "error: no method" });
                return;
            }

            this.setupStreamEventHandlers(method, requestObj);
            this.status({ fill: "green", shape: "dot", text: "listening" });
        }

        setupStreamEventHandlers(method, requestObj) {
            this.state.activeCall.on("data", (data) => processStreamData(data, method, this));

            this.state.activeCall.on("end", () => {
                this.status({ fill: "red", shape: "ring", text: "stream ended" });
                this.state.activeCall = null;

                if (this.state.autoReconnect && !this.state.manualStop && method === "GetOperationEvents") {
                    this.attemptReconnect(method, requestObj);
                }
            });

            this.state.activeCall.on("error", (err) => {
                const shouldReconnect = handleStreamError(err, this, this.state);
                if (shouldReconnect) {
                    this.attemptReconnect(method, requestObj);
                }
            });
        }

        attemptReconnect(method, requestObj) {
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
                text: `reconnecting (${reconnectAttempts}${maxReconnectTries === 0 ? "+" : "/" + maxReconnectTries})...`
            });

            setTimeout(() => {
                this.log(`Reconnection attempt ${reconnectAttempts} for method ${method}`);
                this.startStream(method, requestObj);
            }, reconnectInterval);
        }

        async handleInput(msg, config, done) {
            try {
                const shouldListen = await this.evaluateProperty(config.listenValue, config.listenType, msg);

                if (!shouldListen) {
                    this.stopStream();
                    done();
                    return;
                }

                if (this.state.method === "GetLogs") {
                    const logRef = await this.evaluateProperty(config.logRefValue, config.logRefType, msg);
                    if (!logRef) {
                        throw new Error("No log reference provided for GetLogs");
                    }
                    await this.startStream("GetLogs", { ref: logRef });
                } else {
                    await this.startStream("GetOperationEvents", {});
                }

                this.state.reconnectAttempts = 0;
                done();
            } catch (error) {
                this.error(`Input processing error: ${error.message}`);
                this.status({ fill: "red", shape: "dot", text: "input error" });
                done(error);
            }
        }

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