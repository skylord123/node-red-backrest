const { flattenEvent, matchesFilter, operationType } = require("./lib/operations");

// How many operations to remember the last status of (for "status changes" filtering)
const MAX_TRACKED = 1000;

module.exports = function (RED) {
    class BackrestOperationEventsNode {
        constructor(config) {
            RED.nodes.createNode(this, config);
            this.mode = config.mode || "manual";
            this.triggerValue = config.triggerValue;
            this.triggerType = config.triggerType;
            // "operation": one message per operation, filtered. "event": Backrest's raw events.
            // Nodes from before 1.0 have no output setting and sent raw events.
            this.output = config.output || "event";
            this.when = config.when || "status";
            this.planType = config.planType || "backrest-any";
            this.planValue = config.planValue || "";
            this.repoType = config.repoType || "backrest-any";
            this.repoValue = config.repoValue || "";
            this.types = Array.isArray(config.types) ? config.types : [];

            this.serverConfig = RED.nodes.getNode(config.config);
            if (!this.serverConfig) {
                this.error("No Backrest server configuration found");
                this.status({ fill: "red", shape: "dot", text: "no config" });
                return;
            }

            this.isSubscribed = false;
            this.lastStatus = new Map(); // operation id -> last status seen
            this.handleEventCallback = data => this.handleEvent(data);

            this.status({ fill: "yellow", shape: "ring", text: "not subscribed" });

            if (this.mode === "always") {
                this.subscribe();
            }

            this.on("input", (msg, send, done) => this.handleInput(msg, send, done));
            this.on("close", done => {
                this.unsubscribe();
                done();
            });
        }

        /** Resolve a plan/repo filter setting to an ID, or undefined for "any". */
        filterValue(type, value) {
            if (type === "backrest-any") return undefined;
            if (type === "backrest-plan" || type === "backrest-repo") return value || undefined;
            const result = RED.util.evaluateNodeProperty(value, type, this, {});
            return result === undefined || result === null || result === "" ? undefined : String(result);
        }

        handleEvent(data) {
            if (this.output === "event") {
                this.send({ payload: data });
                return;
            }
            let filter;
            try {
                filter = {
                    planId: this.filterValue(this.planType, this.planValue),
                    repoId: this.filterValue(this.repoType, this.repoValue),
                    types: this.types,
                    when: this.when
                };
            } catch (err) {
                this.error(`Invalid filter: ${err.message}`);
                return;
            }
            for (const entry of flattenEvent(data)) {
                const { event, operation } = entry;
                const last = this.lastStatus.get(operation.id);
                const pass = matchesFilter(entry, filter, last);
                if (event === "deleted") {
                    this.lastStatus.delete(operation.id);
                } else {
                    this.lastStatus.delete(operation.id); // re-insert to keep the newest last
                    this.lastStatus.set(operation.id, operation.status);
                    if (this.lastStatus.size > MAX_TRACKED) {
                        this.lastStatus.delete(this.lastStatus.keys().next().value);
                    }
                }
                if (!pass) continue;
                const msg = {
                    topic: operation.planId || operation.repoId || "",
                    payload: operation,
                    event,
                    operationType: event === "deleted" ? undefined : operationType(operation),
                    status: operation.status
                };
                if (data.catchUp) msg.catchUp = true;
                this.send(msg);
            }
        }

        subscribe() {
            if (!this.isSubscribed) {
                this.serverConfig.subscribeOperationEvents(this, this.handleEventCallback);
                this.isSubscribed = true;
            }
        }

        unsubscribe() {
            if (this.isSubscribed) {
                this.serverConfig.unsubscribeOperationEvents(this);
                this.isSubscribed = false;
                this.status({ fill: "yellow", shape: "ring", text: "not subscribed" });
            }
        }

        handleInput(msg, send, done) {
            // Only process input messages in manual mode
            if (this.mode === "always") {
                done();
                return;
            }
            RED.util.evaluateNodeProperty(this.triggerValue, this.triggerType, this, msg, (err, shouldListen) => {
                if (err) {
                    this.status({ fill: "red", shape: "dot", text: "input error" });
                    done(err);
                    return;
                }
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
