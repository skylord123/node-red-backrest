module.exports = function (RED) {
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
            this.triggerValue = config.triggerValue;
            this.triggerType = config.triggerType;
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
                const shouldListen = await evaluateProperty(this.triggerValue, this.triggerType, this, msg);
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
            const client = this.serverConfig.client;
            if (!client) {
                throw new Error("No gRPC client available; check the Backrest server configuration.");
            }

            this.activeCall = client.GetLogs({ ref: logRef }, this.serverConfig.createAuthMetadata());

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
