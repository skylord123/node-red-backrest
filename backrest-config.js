const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path = require("path");
const client = require("./lib/client");
const { listResources } = require("./lib/resources");
const { OperationTracker, highest } = require("./lib/catchup");

// Defaults for reconnect logic
const DEFAULT_RECONNECT_INTERVAL = 1000;
const DEFAULT_MAX_RECONNECT_TRIES = 0;

// After reconnecting, wait this long before fetching missed operations, so the new
// stream is subscribed on the server first (duplicates are filtered out).
const CATCH_UP_DELAY = 1000;
const CATCH_UP_RETRY_DELAY = 5000;
const CATCH_UP_ATTEMPTS = 3;

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
            keepCase: false, // camelCase field names, the same as the Backrest JSON API
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
     * Utility: Turn the Backrest URL into a gRPC target (host:port) and whether to use TLS.
     * https:// URLs use TLS (port 443 by default), anything else is plaintext (port 80 by default).
     */
    function parseGrpcTarget(urlString) {
        if (!urlString) return { target: "", secure: false };
        if (!/^https?:\/\//.test(urlString)) {
            return { target: urlString, secure: false };
        }
        const url = new URL(urlString);
        const secure = url.protocol === "https:";
        const port = url.port || (secure ? "443" : "80");
        return { target: `${url.hostname}:${port}`, secure };
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
        this.catchUp = config.catchUp !== false;

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

        // Optional TLS settings for https:// URLs (a core tls-config node)
        this.tlsConfigId = config.tls || "";
        this.tlsConfig = config.tls ? RED.nodes.getNode(config.tls) : null;
        this.tlsOptions = this.buildTlsOptions();
        this.httpsAgent = client.httpsAgentFor(this.tlsOptions);

        // gRPC client + streaming state
        this.client = null;
        this.operationStreamCall = null;  // active call for GetOperationEvents
        this.operationStreamEndOrErrorHandled = false;
        this.subscribers = [];            // array of { node, callback, status } objects
        this.reconnectAttempts = 0;
        this.manualStop = false;
        this.closed = false;

        // Catching up on operations missed while disconnected
        this.tracker = null;          // what has been delivered since subscribing
        this.baselinePromise = null;
        this.catchUpPending = false;
        this.catchUpTimer = null;
        this.reconnectTimer = null;

        this.setupClient();

        // When this config node is closed, stop the stream and close the connection.
        this.on("close", () => {
            this.closed = true;
            this.stopOperationEventsStream();
            if (this.client) {
                this.client.close();
                this.client = null;
            }
        });
    }

    /**
     * Set up the gRPC client, using TLS when the Backrest URL is https://.
     */
    BackrestConfigNode.prototype.setupClient = function() {
        const proto = loadProtoDefinitions();
        const backrestPackage = proto.v1;
        if (!backrestPackage || !backrestPackage.Backrest) {
            this.error("Could not load the Backrest service from proto definitions.");
            return;
        }
        let grpcTarget;
        try {
            grpcTarget = parseGrpcTarget(this.backrest_url);
        } catch (err) {
            this.error(`Invalid Backrest URL "${this.backrest_url}": ${err.message}`);
            return;
        }
        this.log(`Creating gRPC client for Backrest at: ${grpcTarget.target}${grpcTarget.secure ? " (TLS)" : ""}`);

        const channelOptions = {};
        if (grpcTarget.secure && this.tlsOptions && this.tlsOptions.servername) {
            channelOptions["grpc.ssl_target_name_override"] = this.tlsOptions.servername;
        }
        this.client = new backrestPackage.Backrest(
            grpcTarget.target,
            grpcTarget.secure ? this.createSslCredentials() : grpc.credentials.createInsecure(),
            channelOptions
        );
    };

    /**
     * Read the TLS options from the selected tls-config node, if any.
     */
    BackrestConfigNode.prototype.buildTlsOptions = function() {
        if (!this.tlsConfig) return null;
        const opts = {};
        this.tlsConfig.addTLSOptions(opts);
        return opts;
    };

    /**
     * gRPC credentials for an https:// URL, using the TLS config node's settings.
     */
    BackrestConfigNode.prototype.createSslCredentials = function() {
        const opts = this.tlsOptions;
        if (!opts) return grpc.credentials.createSsl();
        if (opts.pfx) {
            this.warn("PKCS#12 certificates aren't supported for Operation Events and Get Logs; use PEM files instead.");
        }
        const toBuffer = v => (v === undefined || v === null ? null : Buffer.isBuffer(v) ? v : Buffer.from(String(v)));
        const verifyOptions = {};
        if (opts.rejectUnauthorized === false) {
            verifyOptions.rejectUnauthorized = false;
            verifyOptions.checkServerIdentity = () => undefined;
        }
        return grpc.credentials.createSsl(toBuffer(opts.ca), toBuffer(opts.key), toBuffer(opts.cert), verifyOptions);
    };

    /**
     * Connection settings for HTTP requests to this Backrest server.
     */
    BackrestConfigNode.prototype.server = function() {
        return { url: this.backrest_url, username: this.username, password: this.password, httpsAgent: this.httpsAgent };
    };

    /**
     * Options for HTTP requests to this Backrest server (auth and TLS).
     */
    BackrestConfigNode.prototype.requestOptions = function() {
        return client.requestOptions(this.server());
    };

    /**
     * Call a Backrest API method (such as "GetConfig") and resolve with the response body.
     */
    BackrestConfigNode.prototype.request = function(method, body = {}) {
        return client.request(this.server(), method, body);
    };

    /**
     * Build gRPC metadata carrying this server's credentials.
     */
    BackrestConfigNode.prototype.createAuthMetadata = function() {
        return createAuthMetadata(this.username, this.password);
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
        this.subscribers.filter(sub => sub.status).forEach(sub => {
            sub.node.status(statusObj);
        });
    };

    /**
     * Start the single OperationEvents stream, if not already started.
     */
    BackrestConfigNode.prototype.startOperationEventsStream = function() {
        if (this.operationStreamCall) {
            this.debug("OperationEvents stream already active; ignoring start request.");
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

        // Start tracking deliveries when (re)subscribing from scratch.
        if (!this.tracker) {
            this.tracker = new OperationTracker();
            this.findBaseline();
        }

        // Start the call
        this.operationStreamCall = this.client.GetOperationEvents({}, metadata);
        if (this.catchUpPending) {
            clearTimeout(this.catchUpTimer);
            this.catchUpTimer = setTimeout(() => this.runCatchUp(1), CATCH_UP_DELAY);
        }

        // Wire up events
        this.operationStreamCall.on("data", (data) => {
            // If we receive data, the connection is working;
            // reset reconnectAttempts if needed.
            if (this.reconnectAttempts > 0) {
                this.reconnectAttempts = 0;
                this.updateSubscribersStatus();
            }
            // Backrest sends a keep-alive every minute; it carries no information.
            if (data.event === "keepAlive") return;
            const event = this.tracker ? this.tracker.filterEvent(data) : data;
            if (event) this.broadcast(event);
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
     * Send an event to all subscribers.
     */
    BackrestConfigNode.prototype.broadcast = function(event) {
        for (const sub of this.subscribers.slice()) {
            sub.callback(event);
        }
    };

    /**
     * Find the newest change on the server when subscribing, so a later catch-up only
     * fetches what changed after that. The newest operations by ID give a starting
     * point; older operations changed since then (such as forgotten snapshots) are
     * then fetched by modno.
     */
    BackrestConfigNode.prototype.findBaseline = function() {
        const tracker = this.tracker;
        this.baselinePromise = (async () => {
            try {
                const recent = await this.request("GetOperations", { selector: {}, lastN: 100 });
                const top = highest(recent.operations);
                const newer = await this.request("GetOperations", { selector: { modnoGte: String(top.modno + 1) } });
                const topNewer = highest(newer.operations);
                tracker.setBaseline(Math.max(top.modno, topNewer.modno), Math.max(top.id, topNewer.id));
            } catch (err) {
                this.debug(`Couldn't read the latest operation changes: ${err.message}`);
            }
        })();
        return this.baselinePromise;
    };

    /**
     * Fetch and send the operations that changed while the stream was disconnected.
     */
    BackrestConfigNode.prototype.runCatchUp = async function(attempt) {
        this.catchUpTimer = null;
        if (this.closed || !this.catchUpPending || !this.operationStreamCall || !this.tracker) return;
        const tracker = this.tracker;
        if (tracker.modno === null) {
            await this.baselinePromise;
        }
        if (tracker.modno === null) {
            // We never learned where we were, so we can't tell what was missed.
            this.catchUpPending = false;
            this.findBaseline();
            return;
        }
        try {
            const res = await this.request("GetOperations", { selector: { modnoGte: String(tracker.modno + 1) } });
            if (this.tracker !== tracker || !this.catchUpPending) return;
            const events = tracker.catchUpEvents(res.operations || []);
            this.catchUpPending = false;
            const count = events.reduce((n, e) => n + (e.createdOperations || e.updatedOperations).operations.length, 0);
            if (count) this.log(`Sending ${count} operation change(s) missed while disconnected.`);
            for (const event of events) this.broadcast(event);
        } catch (err) {
            if (attempt < CATCH_UP_ATTEMPTS && this.operationStreamCall) {
                this.catchUpTimer = setTimeout(() => this.runCatchUp(attempt + 1), CATCH_UP_RETRY_DELAY);
            } else {
                this.warn(`Couldn't fetch operations missed while disconnected: ${err.message}`);
            }
        }
    };

    /**
     * Stop the OperationEvents stream, if active.
     */
    BackrestConfigNode.prototype.stopOperationEventsStream = function() {
        // A deliberate stop: the next subscription starts fresh, without catching up.
        clearTimeout(this.catchUpTimer);
        this.catchUpTimer = null;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.catchUpPending = false;
        this.tracker = null;
        if (this.operationStreamCall) {
            this.log("Stopping OperationEvents stream...");
            this.manualStop = true;
            this.operationStreamCall.cancel();
            this.operationStreamCall = null;
        }
        // Do not reset reconnectAttempts here since they persist until a successful connection.
        this.subscribers.filter(sub => sub.status).forEach(sub => {
            sub.node.status({ fill: "yellow", shape: "ring", text: "not subscribed" });
        });
    };

    /**
     * Handle stream error (or unexpected end) and possibly trigger a reconnect.
     */
    BackrestConfigNode.prototype.handleOperationStreamError = function(err) {
        if (err.code === ERROR_CODES.CANCELLED && err.details === "Cancelled on client") {
            this.debug("OperationEvents stream cancelled by client (manual stop).");
            return;
        }
        switch (err.code) {
            case ERROR_CODES.DEADLINE_EXCEEDED:
                this.error("OperationEvents stream timed out.");
                break;
            case ERROR_CODES.UNAVAILABLE:
                this.error(`OperationEvents stream: server unavailable (${err.details}).`);
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
            this.debug("Not reconnecting: manual stop triggered.");
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
        if (this.catchUp && this.tracker) {
            this.catchUpPending = true;
        }
        this.log(`Reconnecting OperationEvents stream (attempt #${this.reconnectAttempts}) in ${this.reconnectInterval}ms...`);
        this.updateSubscribersStatus();
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.closed || this.subscribers.length === 0) return;
            this.startOperationEventsStream();
        }, this.reconnectInterval);
    };

    /**
     * Subscribe a node to the OperationEvents stream. Provide a callback for receiving data.
     * With options.status false the node's status is left alone (it shows its own).
     */
    BackrestConfigNode.prototype.subscribeOperationEvents = function(node, callback, options = {}) {
        const status = options.status !== false;
        const existing = this.subscribers.find(s => s.node.id === node.id);
        if (!existing) {
            this.debug(`Node ${node.id} subscribed to OperationEvents.`);
            this.subscribers.push({ node, callback, status });
        }
        if (!this.operationStreamCall) {
            this.startOperationEventsStream();
        } else if (status) {
            node.status({ fill: "green", shape: "dot", text: "subscribed" });
        }
    };

    /**
     * Unsubscribe a node from the OperationEvents stream. If no subscribers remain, stop the stream.
     */
    BackrestConfigNode.prototype.unsubscribeOperationEvents = function(node) {
        const idx = this.subscribers.findIndex(s => s.node.id === node.id);
        if (idx !== -1) {
            this.debug(`Node ${node.id} unsubscribing from OperationEvents.`);
            if (this.subscribers[idx].status) {
                this.subscribers[idx].node.status({ fill: "yellow", shape: "ring", text: "not subscribed" });
            }
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

    /**
     * Editor endpoint: list the plans, repositories and recent operations of a Backrest
     * server, for the pickers in the node edit dialogs.
     *
     * Body: { config, include, url?, username?, password?, tls? }. `config` is the
     * backrest-config node ID. When the editor has unsaved changes to that config node
     * it also sends `url` and the other settings; a missing password falls back to the
     * deployed one.
     */
    RED.httpAdmin.post("/backrest/resources", RED.auth.needsPermission("backrest-config.read"), async function(req, res) {
        const body = req.body || {};
        const deployed = body.config ? RED.nodes.getNode(body.config) : null;
        let server;
        if (body.url) {
            const password = body.password && body.password !== "__PWRD__" ? body.password : (deployed ? deployed.password : "");
            const tlsNode = body.tls ? RED.nodes.getNode(body.tls) : null;
            let tlsOptions = null;
            if (tlsNode) {
                tlsOptions = {};
                tlsNode.addTLSOptions(tlsOptions);
            } else if (deployed && body.tls === deployed.tlsConfigId) {
                tlsOptions = deployed.tlsOptions;
            }
            server = {
                url: String(body.url).trim().replace(/\/?$/, ""),
                username: body.username || "",
                password,
                httpsAgent: client.httpsAgentFor(tlsOptions)
            };
        } else if (deployed) {
            server = deployed.server();
        } else {
            res.status(400).json({ error: "Enter the Backrest URL in the server config, or deploy it first" });
            return;
        }
        const include = Array.isArray(body.include) ? body.include : ["plans", "repos"];
        try {
            res.json(await listResources(server, include));
        } catch (err) {
            res.status(502).json({ error: err.message });
        }
    });
};
