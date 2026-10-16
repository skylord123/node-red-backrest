// Keeps track of which operation changes have been delivered, so operations that
// changed while the event stream was disconnected can be sent after reconnecting
// (without sending anything twice).
//
// Backrest gives every operation change a new, increasing "modno". We remember the
// highest modno delivered, plus the last modno of recently seen operations.

const MAX_TRACKED = 5000;

class OperationTracker {
    constructor(maxTracked = MAX_TRACKED) {
        this.maxTracked = maxTracked;
        this.modno = null;   // highest modno delivered (null until known)
        this.maxId = 0;      // highest operation ID seen
        this.seen = new Map(); // operation ID -> last modno delivered
    }

    /** Set the starting point: changes up to this modno happened before we subscribed. */
    setBaseline(modno, maxId) {
        if (this.modno === null || modno > this.modno) this.modno = modno;
        if (maxId > this.maxId) this.maxId = maxId;
    }

    /** Record an operation; returns false if this change was already delivered. */
    record(op) {
        const modno = Number(op.modno);
        const prev = this.seen.get(op.id);
        if (prev !== undefined && modno <= prev) return false;
        this.seen.delete(op.id); // re-insert so the most recent stay in the map
        this.seen.set(op.id, modno);
        if (this.seen.size > this.maxTracked) this.seen.delete(this.seen.keys().next().value);
        if (this.modno === null || modno > this.modno) this.modno = modno;
        if (Number(op.id) > this.maxId) this.maxId = Number(op.id);
        return true;
    }

    /**
     * Filter an event from the stream, dropping operation changes already delivered.
     * Returns the event to send, or null if nothing is left.
     */
    filterEvent(event) {
        for (const key of ["createdOperations", "updatedOperations"]) {
            if (event[key]) {
                const operations = (event[key].operations || []).filter(op => this.record(op));
                if (!operations.length) return null;
                return { ...event, [key]: { ...event[key], operations } };
            }
        }
        if (event.deletedOperations) {
            for (const id of event.deletedOperations.values || []) this.seen.delete(String(id));
        }
        return event;
    }

    /**
     * Turn operations fetched after a reconnect into events: operations we never saw
     * as createdOperations, the rest as updatedOperations. Already delivered changes
     * are left out. Events are marked with catchUp: true.
     */
    catchUpEvents(operations) {
        const maxIdBefore = this.maxId;
        const created = [];
        const updated = [];
        const sorted = operations.slice().sort((a, b) => Number(a.modno) - Number(b.modno));
        for (const op of sorted) {
            const known = this.seen.has(op.id) || Number(op.id) <= maxIdBefore;
            if (!this.record(op)) continue;
            (known ? updated : created).push(op);
        }
        const events = [];
        if (created.length) events.push({ createdOperations: { operations: created }, event: "createdOperations", catchUp: true });
        if (updated.length) events.push({ updatedOperations: { operations: updated }, event: "updatedOperations", catchUp: true });
        return events;
    }
}

/** Highest modno and operation ID in a list of operations. */
function highest(operations) {
    let modno = 0;
    let id = 0;
    for (const op of operations || []) {
        modno = Math.max(modno, Number(op.modno) || 0);
        id = Math.max(id, Number(op.id) || 0);
    }
    return { modno, id };
}

module.exports = { OperationTracker, highest };
