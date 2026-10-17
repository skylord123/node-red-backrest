const { evaluate, evaluateId } = require("./lib/properties");
const ops = require("./lib/operations");

// While looking for the backup's operation: poll quickly at first, then back off.
const FIND_POLL_MS = [500, 1000, 1000, 2000, 2000, 5000];
// Once found, events normally deliver every update; poll occasionally in case the stream is down.
const TRACK_POLL_MS = 15000;
// After Backrest has answered the backup request, how many polls to wait for the operation.
const POLLS_AFTER_RESPONSE = 5;

module.exports = function (RED) {
    /** One backup started by one input message. */
    class BackupJob {
        constructor(node, msg, send, done, planId, dryRun) {
            Object.assign(this, { node, msg, send, done, planId, dryRun });
            this.baseline = 0;     // newest operation ID before the backup was requested
            this.op = null;        // the backup operation, once identified
            this.finished = false;
            this.timer = null;
            this.polls = 0;
            this.responded = false;
            this.responseError = null;
            this.pollsSinceResponse = 0;
        }

        async start() {
            const latest = await this.node.serverConfig.request("GetOperations", { selector: {}, lastN: 1 });
            const last = (latest.operations || []).slice(-1)[0];
            this.baseline = last ? Number(last.id) : 0;
            if (this.finished) return;

            this.node.serverConfig.request("Backup", { value: this.planId, dryRun: this.dryRun })
                .then(() => this.onResponse(null), err => this.onResponse(err));
            this.schedulePoll();
        }

        /** Does this (new) operation belong to our backup? */
        matches(op) {
            return Number(op.id) > this.baseline &&
                op.planId === this.planId &&
                ops.operationType(op) === "backup" &&
                !!(op.operationBackup && op.operationBackup.dryRun) === this.dryRun &&
                !this.node.claimed.has(op.id);
        }

        onOperation(op) {
            if (this.finished) return;
            if (!this.op) {
                if (!this.matches(op)) return;
                this.node.claimed.add(op.id);
                this.op = op;
                if (!this.node.wait) {
                    this.finish();
                    return;
                }
            } else if (op.id !== this.op.id) {
                return;
            }
            this.op = op;
            if (ops.isFinal(op.status)) {
                this.finish();
            } else {
                this.node.updateStatus();
            }
        }

        onResponse(err) {
            this.responded = true;
            this.responseError = err;
            if (this.finished) return;
            // Backrest rejected the request outright (unknown plan, bad request): nothing was started.
            if (err && !this.op && err.status && err.status < 500) {
                this.fail(err);
                return;
            }
            // Otherwise the backup has finished (or the connection dropped, for example a proxy
            // timeout); look the operation up now rather than waiting for the next poll.
            this.poll();
        }

        schedulePoll() {
            clearTimeout(this.timer);
            if (this.finished) return;
            const delay = this.op ? TRACK_POLL_MS : FIND_POLL_MS[Math.min(this.polls, FIND_POLL_MS.length - 1)];
            this.timer = setTimeout(() => this.poll(), delay);
        }

        async poll() {
            clearTimeout(this.timer);
            if (this.finished) return;
            this.polls++;
            try {
                const selector = this.op ? { ids: [this.op.id] } : { planId: this.planId };
                const res = await this.node.serverConfig.request("GetOperations", { selector, lastN: 50 });
                const list = (res.operations || []).slice().sort((a, b) => Number(a.id) - Number(b.id));
                for (const op of list) this.onOperation(op);
            } catch (err) {
                this.node.debug(`Polling for backup of ${this.planId} failed: ${err.message}`);
            }
            if (this.finished) return;
            if (!this.op && this.responded) {
                this.pollsSinceResponse++;
                if (this.pollsSinceResponse >= POLLS_AFTER_RESPONSE) {
                    this.fail(this.responseError || new Error(`Backrest didn't create a backup operation for plan ${this.planId}`));
                    return;
                }
            }
            this.schedulePoll();
        }

        finish() {
            this.finished = true;
            clearTimeout(this.timer);
            const op = this.op;
            const result = ops.backupResult(op);
            const msg = this.msg;
            msg.payload = result;
            msg.operation = op;
            const ok = !ops.isFinal(op.status) || ops.isSuccess(op.status);
            this.send(ok ? [msg, null] : [null, msg]);
            this.node.jobDone(this, result);
            this.done();
        }

        fail(err) {
            this.finished = true;
            clearTimeout(this.timer);
            this.node.jobDone(this, null, err);
            this.done(err);
        }

        /** Stop tracking (node closing); the backup itself keeps running in Backrest. */
        cancel() {
            this.finished = true;
            clearTimeout(this.timer);
            this.done();
        }
    }

    class BackrestRunBackupNode {
        constructor(config) {
            RED.nodes.createNode(this, config);
            this.planValue = config.planValue;
            this.planType = config.planType || "backrest-plan";
            this.dryRunValue = config.dryRunValue === undefined ? "false" : config.dryRunValue;
            this.dryRunType = config.dryRunType || "bool";
            this.wait = config.wait !== false;

            this.serverConfig = RED.nodes.getNode(config.config);
            if (!this.serverConfig) {
                this.error("No Backrest server configuration found");
                this.status({ fill: "red", shape: "dot", text: "no config" });
                return;
            }

            this.jobs = new Set();
            this.claimed = new Set(); // operation IDs already matched to a job
            this.subscribed = false;
            this.eventCallback = data => {
                for (const { event, operation } of ops.flattenEvent(data)) {
                    if (event === "deleted") continue;
                    for (const job of Array.from(this.jobs)) job.onOperation(operation);
                }
            };

            this.on("input", (msg, send, done) => this.handleInput(msg, send, done));
            this.on("close", done => {
                for (const job of this.jobs) job.cancel();
                this.jobs.clear();
                this.unsubscribe();
                this.status({});
                done();
            });
        }

        async handleInput(msg, send, done) {
            let job;
            try {
                const planId = await evaluateId(RED, this, this.planValue, this.planType, msg, "plan");
                const dryRun = await evaluate(RED, this, this.dryRunValue, this.dryRunType, msg);
                job = new BackupJob(this, msg, send, done, planId, dryRun === true || dryRun === "true");
                this.jobs.add(job);
                // Subscribe before starting so no event about the new backup is missed.
                this.subscribe();
                this.updateStatus();
                await job.start();
            } catch (err) {
                if (job) {
                    if (!job.finished) job.fail(err);
                } else {
                    this.status({ fill: "red", shape: "dot", text: err.message });
                    done(err);
                }
            }
        }

        subscribe() {
            if (this.subscribed) return;
            this.subscribed = true;
            this.serverConfig.subscribeOperationEvents(this, this.eventCallback, { status: false });
        }

        unsubscribe() {
            if (!this.subscribed) return;
            this.subscribed = false;
            this.serverConfig.unsubscribeOperationEvents(this);
        }

        jobDone(job, result, err) {
            this.jobs.delete(job);
            if (job.op) this.claimed.delete(job.op.id);
            if (this.jobs.size === 0) this.unsubscribe();
            if (this.jobs.size > 0) {
                this.updateStatus();
            } else if (err) {
                this.status({ fill: "red", shape: "dot", text: `${job.planId}: ${err.message}` });
            } else if (!this.wait) {
                this.status({ fill: "blue", shape: "dot", text: `${job.planId}: started` });
            } else {
                const ok = ops.isSuccess(result.status);
                const label = result.status.replace(/^STATUS_/, "").toLowerCase().replace("_", " ");
                const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                this.status({ fill: ok ? "green" : "red", shape: "dot", text: `${job.planId}: ${label} at ${time}` });
            }
        }

        updateStatus() {
            const jobs = Array.from(this.jobs);
            if (jobs.length === 0) return;
            if (jobs.length > 1) {
                this.status({ fill: "blue", shape: "ring", text: `${jobs.length} backups running` });
                return;
            }
            const job = jobs[0];
            if (!job.op || job.op.status === "STATUS_PENDING") {
                this.status({ fill: "blue", shape: "ring", text: `${job.planId}: waiting to start` });
                return;
            }
            const pct = ops.backupProgress(job.op);
            this.status({ fill: "blue", shape: "dot", text: `${job.planId}: ${pct === undefined ? "running" : pct + "%"}` });
        }
    }

    RED.nodes.registerType("backrest-run-backup", BackrestRunBackupNode);
};
