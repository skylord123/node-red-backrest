module.exports = function (RED) {
    class BackrestOperationEventsNode {
        constructor(config) {
            RED.nodes.createNode(this, config);
            // Save config properties
            this.listenValue = config.listenValue;
            this.listenType = config.listenType;
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
            // Handle input messages
            this.on("input", (msg, send, done) => this.handleInput(msg, send, done));
            // On close, unsubscribe if needed
            this.on("close", () => {
                if (this.isSubscribed) {
                    this.serverConfig.unsubscribeOperationEvents(this);
                }
            });
        }

        async handleInput(msg, send, done) {
            // Use the asynchronous version of evaluateNodeProperty
            RED.util.evaluateNodeProperty(this.listenValue, this.listenType, this, msg, (err, shouldListen) => {
                if (err) {
                    this.error(`Error evaluating listenValue: ${err.message}`);
                    this.status({ fill: "red", shape: "dot", text: "input error" });
                    done(err);
                    return;
                }
                this.debug("listen = " + (shouldListen ? "Yes" : "No"));
                if (shouldListen) {
                    if (!this.isSubscribed) {
                        this.serverConfig.subscribeOperationEvents(this, this.handleEventCallback);
                        this.isSubscribed = true;
                        // The config node will update our status based on connection state.
                    }
                } else {
                    if (this.isSubscribed) {
                        this.serverConfig.unsubscribeOperationEvents(this);
                        this.isSubscribed = false;
                        this.status({ fill: "yellow", shape: "ring", text: "not subscribed" });
                    }
                }
                done();
            });
        }
    }

    RED.nodes.registerType("backrest-operation-events", BackrestOperationEventsNode);
};
