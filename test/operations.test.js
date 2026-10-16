// Unit tests for lib/operations.js (no Backrest needed)
const assert = require("assert");
const ops = require("../lib/operations");

const backup = (extra = {}) => ({
    id: "5", planId: "p1", repoId: "r1", status: "STATUS_INPROGRESS", op: "operationBackup",
    operationBackup: {}, ...extra
});

describe("lib/operations", function () {
    it("names operation types", function () {
        assert.strictEqual(ops.operationType(backup()), "backup");
        assert.strictEqual(ops.operationType({ operationRunCommand: {} }), "command");
        assert.strictEqual(ops.operationType({ op: "operationIndexSnapshot" }), "index-snapshot");
        assert.strictEqual(ops.operationType({}), "unknown");
    });

    it("finds an operation's log reference", function () {
        assert.strictEqual(ops.logRefOf({ logref: "a" }), "a");
        assert.strictEqual(ops.logRefOf({ logref: "a", operationRunCommand: { outputLogref: "b" } }), "b");
        assert.strictEqual(ops.logRefOf({}), undefined);
    });

    it("flattens events into one entry per operation", function () {
        assert.deepStrictEqual(ops.flattenEvent({ keepAlive: {}, event: "keepAlive" }), []);
        const created = ops.flattenEvent({ createdOperations: { operations: [backup(), backup({ id: "6" })] } });
        assert.deepStrictEqual(created.map(e => [e.event, e.operation.id]), [["created", "5"], ["created", "6"]]);
        const deleted = ops.flattenEvent({ deletedOperations: { values: ["7"] } });
        assert.deepStrictEqual(deleted, [{ event: "deleted", operation: { id: "7" } }]);
    });

    describe("matchesFilter", function () {
        const created = { event: "created", operation: backup({ status: "STATUS_PENDING" }) };
        const progress = { event: "updated", operation: backup() };
        const done = { event: "updated", operation: backup({ status: "STATUS_SUCCESS" }) };
        const deleted = { event: "deleted", operation: { id: "5" } };

        it("filters by plan, repository and type", function () {
            assert.ok(ops.matchesFilter(created, { planId: "p1", when: "all" }));
            assert.ok(!ops.matchesFilter(created, { planId: "p2", when: "all" }));
            assert.ok(ops.matchesFilter(created, { repoId: "r1", when: "all" }));
            assert.ok(!ops.matchesFilter(created, { repoId: "r2", when: "all" }));
            assert.ok(ops.matchesFilter(created, { types: ["forget", "backup"], when: "all" }));
            assert.ok(!ops.matchesFilter(created, { types: ["forget"], when: "all" }));
        });

        it("sends status changes but skips progress updates", function () {
            const f = { when: "status" };
            assert.ok(ops.matchesFilter(created, f, undefined));
            assert.ok(ops.matchesFilter(progress, f, "STATUS_PENDING"));
            assert.ok(!ops.matchesFilter(progress, f, "STATUS_INPROGRESS"));
            assert.ok(ops.matchesFilter(done, f, "STATUS_INPROGRESS"));
        });

        it("sends only the first final status", function () {
            const f = { when: "final" };
            assert.ok(!ops.matchesFilter(created, f, undefined));
            assert.ok(!ops.matchesFilter(progress, f, "STATUS_PENDING"));
            assert.ok(ops.matchesFilter(done, f, "STATUS_INPROGRESS"));
            assert.ok(ops.matchesFilter(done, f, undefined), "first time we see it, already finished");
            assert.ok(!ops.matchesFilter(done, f, "STATUS_SUCCESS"), "repeated update");
        });

        it("only sends deletions without filters", function () {
            assert.ok(ops.matchesFilter(deleted, { when: "all" }));
            assert.ok(ops.matchesFilter(deleted, { when: "status" }));
            assert.ok(!ops.matchesFilter(deleted, { when: "final" }));
            assert.ok(!ops.matchesFilter(deleted, { when: "all", planId: "p1" }));
            assert.ok(!ops.matchesFilter(deleted, { when: "all", types: ["backup"] }));
        });
    });

    it("summarizes a backup operation with numbers", function () {
        const result = ops.backupResult(backup({
            status: "STATUS_SUCCESS", snapshotId: "abc", unixTimeStartMs: "1000", unixTimeEndMs: "4500",
            operationBackup: { dryRun: false, lastStatus: { summary: { filesNew: "3", dataAdded: "1024", snapshotId: "abc" } } }
        }));
        assert.deepStrictEqual(result, {
            operationId: "5", planId: "p1", repoId: "r1", status: "STATUS_SUCCESS", dryRun: false,
            snapshotId: "abc", startTime: 1000, endTime: 4500, durationMs: 3500, message: undefined,
            summary: { filesNew: 3, dataAdded: 1024, snapshotId: "abc" }
        });
    });

    it("reads backup progress", function () {
        assert.strictEqual(ops.backupProgress(backup({ operationBackup: { lastStatus: { status: { percentDone: 0.425 } } } })), 43);
        assert.strictEqual(ops.backupProgress(backup()), undefined);
    });

    describe("summaryStatus", function () {
        const summary = (status, overdue) => ({
            id: "p1",
            recentBackups: { status: status ? [status] : [], timestampMs: ["2000"], durationMs: ["50"], bytesAdded: ["10"] },
            historyLast30days: [{ overdue: true }, { overdue: !!overdue }],
            backupsSuccessLast30days: "4", protectedBytes: "99", nextBackupTimeMs: "5000"
        });

        it("follows the Backrest dashboard's states", function () {
            assert.strictEqual(ops.summaryStatus(summary("STATUS_SUCCESS"), "plan").state, "ok");
            assert.strictEqual(ops.summaryStatus(summary("STATUS_WARNING"), "plan").state, "warning");
            assert.strictEqual(ops.summaryStatus(summary("STATUS_ERROR"), "plan").state, "error");
            assert.strictEqual(ops.summaryStatus(summary("STATUS_SYSTEM_CANCELLED"), "plan").state, "error");
            assert.strictEqual(ops.summaryStatus(summary("STATUS_INPROGRESS"), "plan").state, "running");
            assert.strictEqual(ops.summaryStatus(summary(null), "plan").state, "idle");
        });

        it("is overdue when today's bucket is overdue", function () {
            assert.strictEqual(ops.summaryStatus(summary("STATUS_SUCCESS"), "plan").overdue, false);
            const s = ops.summaryStatus(summary("STATUS_SUCCESS", true), "plan", { repo: "r1" });
            assert.strictEqual(s.overdue, true);
            assert.strictEqual(s.healthy, false);
            assert.strictEqual(s.repo, "r1");
            assert.strictEqual(s.last30Days.missedDays, 2);
        });

        it("converts numbers", function () {
            const s = ops.summaryStatus(summary("STATUS_SUCCESS"), "plan");
            assert.deepStrictEqual(s.lastBackup, { status: "STATUS_SUCCESS", time: 2000, durationMs: 50, bytesAdded: 10 });
            assert.strictEqual(s.protectedBytes, 99);
            assert.strictEqual(s.nextBackupTime, 5000);
            assert.strictEqual(s.last30Days.success, 4);
        });
    });
});
