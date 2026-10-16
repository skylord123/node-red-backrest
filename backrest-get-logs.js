const { evaluate, evaluateId } = require("./lib/properties");
const { logRefOf } = require("./lib/operations");

// gRPC status code for a call cancelled by the client
const CANCELLED = 1;

module.exports = function (RED) {
    class BackrestGetLogsNode {
        constructor(config) {
            RED.nodes.createNode(this, config);
            this.serverConfig = RED.nodes.getNode(config.config);
            if (!this.serverConfig) {
                this.error("No Backrest server configuration found");
                this.status({ fill: "red", shape: "dot", text: "no config" });
                return;
            }
            this.triggerValue = config.triggerValue;
            this.triggerType = config.triggerType;
            // "operation": look up the log of an operation. "logref": use a log reference directly.
            // Nodes from before 1.0 have no source and always used a log reference.
            this.source = config.source || "logref";
            this.operationValue = config.operationValue;
            this.operationType = config.operationType;
            this.logRefValue = config.logRefValue;
            this.logRefType = config.logRefType;

            // The stream currently running: { call, done }
            this.active = null;

            this.on("input", (msg, send, done) => this.handleInput(msg, send, done));
            this.on("close", () => this.stopStream());

            this.status({});
        }

        /** Stop the running stream (if any) and complete its message. */
        stopStream() {
            const active = this.active;
            if (!active) return;
            this.active = null;
            active.stopped = true;
            active.call.cancel();
            active.done();
            this.status({});
        }

        async resolveLogRef(msg) {
            if (this.source === "logref") {
                const logRef = await evaluate(RED, this, this.logRefValue, this.logRefType, msg);
                if (!logRef) throw new Error("No log reference given");
                return { logRef: String(logRef) };
            }
            const id = await evaluateId(RED, this, this.operationValue, this.operationType, msg, "operation");
            const res = await this.serverConfig.request("GetOperations", { selector: { ids: [id] } });
            const op = (res.operations || [])[0];
            if (!op) throw new Error(`Operation ${id} not found`);
            const logRef = logRefOf(op);
            if (!logRef) throw new Error(`Operation ${id} has no logs (yet)`);
            return { logRef, operationId: id };
        }

        async handleInput(msg, send, done) {
            try {
                const shouldListen = await evaluate(RED, this, this.triggerValue, this.triggerType, msg);
                if (!shouldListen) {
                    this.stopStream();
                    done();
                    return;
                }
                const { logRef, operationId } = await this.resolveLogRef(msg);
                this.startLogsStream(msg, logRef, operationId, send, done);
            } catch (err) {
                this.status({ fill: "red", shape: "dot", text: err.message });
                done(err);
            }
        }

        startLogsStream(msg, logRef, operationId, send, done) {
            this.stopStream();
            const client = this.serverConfig.client;
            if (!client) {
                throw new Error("No gRPC client available; check the Backrest server configuration.");
            }

            const call = client.GetLogs({ ref: logRef }, this.serverConfig.createAuthMetadata());
            const active = { call, done: () => {}, stopped: false };
            let finished = false;
            const finish = err => {
                if (finished) return;
                finished = true;
                if (this.active === active) {
                    this.active = null;
                    this.status(err ? { fill: "red", shape: "dot", text: "error" } : {});
                }
                done(err);
            };
            active.done = () => finish();
            this.active = active;

            call.on("data", chunk => {
                const text = chunk.value.toString("utf8");
                const out = RED.util.cloneMessage(msg);
                try {
                    out.payload = JSON.parse(text);
                } catch (err) {
                    out.payload = text;
                }
                out.logRef = logRef;
                if (operationId) out.operationId = operationId;
                send(out);
            });
            call.on("error", err => {
                if (active.stopped || err.code === CANCELLED) {
                    finish();
                    return;
                }
                finish(new Error(`GetLogs stream error: ${err.details || err.message}`));
            });
            call.on("end", () => finish());

            this.status({ fill: "green", shape: "dot", text: operationId ? `streaming operation ${operationId}` : "streaming" });
        }
    }

    RED.nodes.registerType("backrest-get-logs", BackrestGetLogsNode);
};
