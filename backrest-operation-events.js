module.exports = function (RED) {
    class BackrestOperationEventsNode {
        constructor(config) {
            RED.nodes.createNode(this, config);
            // Save config properties
            this.mode = config.mode || "manual";
            this.triggerValue = config.triggerValue;
            this.triggerType = config.triggerType;

            // Reference to the config node
            this.serverConfig = RED.nodes.getNode(config.config);
            if (!this.serverConfig) {
                this.error("No Backrest server configuration found");
                this.status({ fill: "red", shape: "dot", text: "no config" });
                return;
            }

            // Whether we're currently subscribed
            this.isSubscribed = false;

            // Callback to receive events from config node
            this.handleEventCallback = (data) => {
                this.send({ payload: data });
            };

            // Initial status: not subscribed
            this.status({ fill: "yellow", shape: "ring", text: "not subscribed" });

            // If mode is "always", subscribe immediately
            if (this.mode === "always") {
                this.subscribe();
            }

            // Handle input messages (only relevant in manual mode)
            this.on("input", (msg, send, done) => this.handleInput(msg, send, done));

            // On close, unsubscribe if needed
            this.on("close", (done) => {
                this.unsubscribe();
                done();
            });
        }

        subscribe() {
            if (!this.isSubscribed) {
                this.serverConfig.subscribeOperationEvents(this, this.handleEventCallback);
                this.isSubscribed = true;
                // The config node will update our status based on connection state
            }
        }

        unsubscribe() {
            if (this.isSubscribed) {
                this.serverConfig.unsubscribeOperationEvents(this);
                this.isSubscribed = false;
                this.status({ fill: "yellow", shape: "ring", text: "not subscribed" });
            }
        }

        async handleInput(msg, send, done) {
            // Only process input messages in manual mode
            if (this.mode === "always") {
                done();
                return;
            }

            // Use the asynchronous version of evaluateNodeProperty
            RED.util.evaluateNodeProperty(this.triggerValue, this.triggerType, this, msg, (err, shouldListen) => {
                if (err) {
                    this.error(`Error evaluating triggerValue: ${err.message}`);
                    this.status({ fill: "red", shape: "dot", text: "input error" });
                    done(err);
                    return;
                }

                this.debug("listen = " + (shouldListen ? "Yes" : "No"));

                if (shouldListen) {
                    this.subscribe();
                } else {
                    this.unsubscribe();
                }

                done();
            });
        }
    }

    RED.nodes.registerType("backrest-operation-events", BackrestOperationEventsNode);
};