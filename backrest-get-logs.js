const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path = require("path");

module.exports = function (RED) {
    // Cache proto definitions
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

    function createAuthMetadata(username, password) {
        const metadata = new grpc.Metadata();
        if (username && password) {
            const authString = Buffer.from(`${username}:${password}`).toString("base64");
            metadata.add("Authorization", `Basic ${authString}`);
        }
        return metadata;
    }

    // Utility to promisify RED.util.evaluateNodeProperty.
    function evaluateProperty(prop, type, node, msg) {
        return new Promise((resolve, reject) => {
            RED.util.evaluateNodeProperty(prop, type, node, msg, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
    }

    class BackrestGetLogsNode {
        constructor(config) {
            RED.nodes.createNode(this, config);
            this.serverConfig = RED.nodes.getNode(config.config);
            if (!this.serverConfig) {
                this.error("No Backrest server configuration found");
                this.status({ fill: "red", shape: "dot", text: "no config" });
                return;
            }
            // Store configuration properties
            this.listenValue = config.listenValue;
            this.listenType = config.listenType;
            this.logRefValue = config.logRefValue;
            this.logRefType = config.logRefType;

            // Ephemeral stream state
            this.activeCall = null;

            this.on("input", (msg, send, done) => this.handleInput(msg, send, done));
            this.on("close", () => this.stopStream());

            this.status({ fill: "red", shape: "ring", text: "disconnected" });
        }

        stopStream() {
            if (this.activeCall) {
                this.activeCall.cancel();
                this.activeCall = null;
            }
            this.status({ fill: "red", shape: "ring", text: "disconnected" });
        }

        async handleInput(msg, send, done) {
            try {
                // Evaluate if we should start listening
                const shouldListen = await evaluateProperty(this.listenValue, this.listenType, this, msg);
                this.debug("shouldListen = " + (shouldListen ? "Yes" : "No"));

                if (!shouldListen) {
                    this.stopStream();
                    done();
                    return;
                }

                // Evaluate the logRef
                const logRef = await evaluateProperty(this.logRefValue, this.logRefType, this, msg);
                if (!logRef) {
                    throw new Error("No logRef provided");
                }

                // Start the ephemeral stream
                await this.startLogsStream(logRef, send);
                done();
            } catch (err) {
                this.error(err.message);
                this.status({ fill: "red", shape: "dot", text: "input error" });
                done(err);
            }
        }

        async startLogsStream(logRef, send) {
            this.stopStream(); // Stop any existing stream
            const proto = loadProtoDefinitions();
            const backrestPackage = proto.v1;
            if (!backrestPackage || !backrestPackage.Backrest) {
                throw new Error("Could not load the Backrest service from proto definitions.");
            }

            // Create insecure (or SSL) client – strip the protocol from the URL
            const target = this.serverConfig.backrest_url.replace(/^https?:\/\//, "");
            const client = new backrestPackage.Backrest(target, grpc.credentials.createInsecure());

            // Build metadata for authentication
            const metadata = createAuthMetadata(this.serverConfig.username, this.serverConfig.password);

            this.activeCall = client.GetLogs({ ref: logRef }, metadata);

            // Register stream events
            this.activeCall.on("data", (chunk) => {
                const str = chunk.value.toString("utf8");
                try {
                    const jsonData = JSON.parse(str);
                    send({ payload: jsonData });
                } catch (err) {
                    send({ payload: str });
                }
            });

            this.activeCall.on("error", (err) => {
                this.error(`GetLogs stream error: ${err.message}`);
                this.stopStream();
            });

            this.activeCall.on("end", () => {
                this.log("GetLogs stream ended.");
                this.stopStream();
            });

            this.status({ fill: "green", shape: "dot", text: `listening [logRef:${logRef}]` });
        }
    }

    RED.nodes.registerType("backrest-get-logs", BackrestGetLogsNode);
};
