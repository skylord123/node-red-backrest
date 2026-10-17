// Helpers for working with Backrest operations and summaries.
// Operations here use the camelCase JSON form returned by the Backrest API.

const FINAL_STATUSES = new Set([
    "STATUS_SUCCESS",
    "STATUS_WARNING",
    "STATUS_ERROR",
    "STATUS_SYSTEM_CANCELLED",
    "STATUS_USER_CANCELLED"
]);

// Operation field name -> short type name used in node options and msg.operationType
const OPERATION_TYPES = {
    operationBackup: "backup",
    operationIndexSnapshot: "index-snapshot",
    operationForget: "forget",
    operationPrune: "prune",
    operationRestore: "restore",
    operationStats: "stats",
    operationRunHook: "hook",
    operationCheck: "check",
    operationRunCommand: "command"
};

function isFinal(status) {
    return FINAL_STATUSES.has(status);
}

function isSuccess(status) {
    return status === "STATUS_SUCCESS" || status === "STATUS_WARNING";
}

/** Short type name of an operation ("backup", "forget", ...), or "unknown". */
function operationType(op) {
    if (!op) return "unknown";
    if (op.op && OPERATION_TYPES[op.op]) return OPERATION_TYPES[op.op];
    for (const key of Object.keys(OPERATION_TYPES)) {
        if (op[key]) return OPERATION_TYPES[key];
    }
    return "unknown";
}

/** The log reference holding an operation's output, if it has one. */
function logRefOf(op) {
    if (!op) return undefined;
    return (op.operationRunCommand && op.operationRunCommand.outputLogref) ||
        (op.operationRunHook && op.operationRunHook.outputLogref) ||
        op.logref || undefined;
}

/** int64 values arrive as strings; turn them into numbers (undefined stays undefined). */
function num(value) {
    if (value === undefined || value === null || value === "") return undefined;
    const n = Number(value);
    return Number.isNaN(n) ? undefined : n;
}

/**
 * Split an OperationEvent into one entry per operation.
 * Returns [] for keep-alive events.
 */
function flattenEvent(event) {
    if (!event) return [];
    if (event.createdOperations) {
        return (event.createdOperations.operations || []).map(operation => ({ event: "created", operation }));
    }
    if (event.updatedOperations) {
        return (event.updatedOperations.operations || []).map(operation => ({ event: "updated", operation }));
    }
    if (event.deletedOperations) {
        return (event.deletedOperations.values || []).map(id => ({ event: "deleted", operation: { id: String(id) } }));
    }
    return [];
}

/**
 * Decide whether an operation event passes the given filter.
 * filter: { planId, repoId, types: [..], when: "all" | "status" | "final" }
 * `lastStatus` is the status this operation had the last time we saw it (for "status").
 */
function matchesFilter(entry, filter, lastStatus) {
    const { event, operation } = entry;
    const hasTarget = filter.planId || filter.repoId || (filter.types && filter.types.length);
    if (event === "deleted") {
        // Deleted events only carry the operation ID, so they can't be matched against filters.
        return !hasTarget && filter.when !== "final";
    }
    if (filter.planId && operation.planId !== filter.planId) return false;
    if (filter.repoId && operation.repoId !== filter.repoId) return false;
    if (filter.types && filter.types.length && !filter.types.includes(operationType(operation))) return false;
    switch (filter.when) {
        case "final":
            return isFinal(operation.status) && lastStatus !== operation.status;
        case "status":
            return event === "created" || lastStatus !== operation.status;
        default:
            return true;
    }
}

/** A compact, numeric summary of a finished (or running) backup operation. */
function backupResult(op) {
    const backup = op.operationBackup || {};
    const summary = (backup.lastStatus && backup.lastStatus.summary) || null;
    const start = num(op.unixTimeStartMs);
    const end = num(op.unixTimeEndMs);
    const result = {
        operationId: op.id,
        planId: op.planId,
        repoId: op.repoId,
        status: op.status,
        dryRun: !!backup.dryRun,
        snapshotId: op.snapshotId || undefined,
        startTime: start,
        endTime: end || undefined,
        durationMs: start && end ? end - start : undefined,
        message: op.displayMessage || undefined,
        summary: undefined
    };
    if (summary) {
        result.summary = {};
        for (const [key, value] of Object.entries(summary)) {
            result.summary[key] = typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
        }
    }
    return result;
}

/** Backup progress (0-100) of a running backup operation, if known. */
function backupProgress(op) {
    const status = op.operationBackup && op.operationBackup.lastStatus && op.operationBackup.lastStatus.status;
    if (!status || status.percentDone === undefined) return undefined;
    return Math.round(Number(status.percentDone) * 100);
}

/**
 * Turn a SummaryDashboardResponse summary into a status object, using the same
 * rules as the Backrest dashboard: the state comes from the most recent backup and a
 * plan is overdue when today's history bucket is flagged overdue.
 */
function summaryStatus(summary, kind, extra = {}) {
    const recent = summary.recentBackups || {};
    const latestStatus = (recent.status || [])[0];
    let state = "idle";
    if (latestStatus === "STATUS_INPROGRESS" || latestStatus === "STATUS_PENDING") state = "running";
    else if (latestStatus === "STATUS_SUCCESS") state = "ok";
    else if (latestStatus === "STATUS_WARNING") state = "warning";
    else if (latestStatus === "STATUS_ERROR" || latestStatus === "STATUS_SYSTEM_CANCELLED") state = "error";

    const history = summary.historyLast30days || [];
    const today = history[history.length - 1];
    const overdue = !!(today && today.overdue);

    const lastBackup = latestStatus === undefined ? null : {
        status: latestStatus,
        time: num((recent.timestampMs || [])[0]),
        durationMs: num((recent.durationMs || [])[0]),
        bytesAdded: num((recent.bytesAdded || [])[0])
    };

    return {
        type: kind,
        id: summary.id,
        ...extra,
        state,
        overdue,
        healthy: (state === "ok" || state === "running" || state === "idle") && !overdue,
        lastBackup,
        nextBackupTime: num(summary.nextBackupTimeMs) || null,
        protectedBytes: num(summary.protectedBytes) || 0,
        totalSnapshots: num(summary.totalSnapshots) || 0,
        last30Days: {
            success: num(summary.backupsSuccessLast30days) || 0,
            warning: num(summary.backupsWarningLast30days) || 0,
            failed: num(summary.backupsFailed30days) || 0,
            bytesAdded: num(summary.bytesAddedLast30days) || 0,
            bytesScanned: num(summary.bytesScannedLast30days) || 0,
            missedDays: history.filter(b => b.overdue).length
        }
    };
}

module.exports = {
    FINAL_STATUSES,
    OPERATION_TYPES,
    isFinal,
    isSuccess,
    operationType,
    logRefOf,
    num,
    flattenEvent,
    matchesFilter,
    backupResult,
    backupProgress,
    summaryStatus
};
