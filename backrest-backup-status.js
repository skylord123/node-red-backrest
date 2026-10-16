const { evaluate } = require("./lib/properties");
const { summaryStatus } = require("./lib/operations");

module.exports = function (RED) {
    class BackrestBackupStatusNode {
        constructor(config) {
            RED.nodes.createNode(this, config);
            this.show = config.show === "repos" ? "repos" : "plans";
            this.targetValue = config.targetValue || "";
            this.targetType = config.targetType || "backrest-any";
            this.output = config.output === "all" ? "all" : "each";
            this.onlyProblems = !!config.onlyProblems;

            this.serverConfig = RED.nodes.getNode(config.config);
            if (!this.serverConfig) {
                this.error("No Backrest server configuration found");
                this.status({ fill: "red", shape: "dot", text: "no config" });
                return;
            }
            this.on("input", (msg, send, done) => this.handleInput(msg, send, done));
        }

        async handleInput(msg, send, done) {
            try {
                const target = await evaluate(RED, this, this.targetValue, this.targetType, msg);
                const targetId = target === undefined || target === null || target === "" ? undefined : String(target);
                const [summary, config] = await Promise.all([
                    this.serverConfig.request("GetSummaryDashboard"),
                    this.show === "plans" ? this.serverConfig.request("GetConfig") : Promise.resolve(null)
                ]);

                const kind = this.show === "plans" ? "plan" : "repo";
                const summaries = (this.show === "plans" ? summary.planSummaries : summary.repoSummaries) || [];
                const repoOf = {};
                if (config) for (const p of config.plans || []) repoOf[p.id] = p.repo;

                let statuses = summaries.map(s => summaryStatus(s, kind, kind === "plan" ? { repo: repoOf[s.id] } : {}));
                if (targetId !== undefined) {
                    statuses = statuses.filter(s => s.id === targetId);
                    if (!statuses.length) throw new Error(`${kind === "plan" ? "Plan" : "Repository"} ${targetId} not found`);
                }
                this.showStatus(statuses);

                const reported = this.onlyProblems ? statuses.filter(s => !s.healthy) : statuses;
                if (this.output === "all") {
                    if (reported.length || !this.onlyProblems) {
                        msg.payload = reported;
                        msg.healthy = reported.every(s => s.healthy);
                        send(msg);
                    }
                } else {
                    reported.forEach((status, i) => {
                        const out = i === reported.length - 1 ? msg : RED.util.cloneMessage(msg);
                        out.payload = status;
                        out.topic = status.id;
                        send(out);
                    });
                }
                done();
            } catch (err) {
                this.status({ fill: "red", shape: "dot", text: err.message });
                done(err);
            }
        }

        showStatus(statuses) {
            const counts = {};
            for (const s of statuses) {
                const key = s.overdue && s.state !== "error" ? "overdue" : s.state;
                counts[key] = (counts[key] || 0) + 1;
            }
            const order = ["error", "overdue", "warning", "running", "ok", "idle"];
            const text = order.filter(k => counts[k]).map(k => `${counts[k]} ${k}`).join(", ") || "nothing found";
            const fill = counts.error ? "red" : (counts.overdue || counts.warning) ? "yellow" : "green";
            this.status({ fill, shape: "dot", text });
        }
    }

    RED.nodes.registerType("backrest-backup-status", BackrestBackupStatusNode);
};
