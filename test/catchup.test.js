// Unit tests for lib/catchup.js (no Backrest needed)
const assert = require("assert");
const { OperationTracker, highest } = require("../lib/catchup");

const op = (id, modno, status = "STATUS_SUCCESS") => ({ id: String(id), modno: String(modno), status });
const ids = event => (event.createdOperations || event.updatedOperations).operations.map(o => `${o.id}@${o.modno}`);

describe("lib/catchup", function () {
    it("finds the highest modno and ID", function () {
        assert.deepStrictEqual(highest([op(3, 10), op(7, 4), op(5, 12)]), { modno: 12, id: 7 });
        assert.deepStrictEqual(highest([]), { modno: 0, id: 0 });
        assert.deepStrictEqual(highest(undefined), { modno: 0, id: 0 });
    });

    it("passes stream events through and remembers what was delivered", function () {
        const t = new OperationTracker();
        t.setBaseline(5, 2);
        const event = { createdOperations: { operations: [op(3, 6, "STATUS_PENDING")] }, event: "createdOperations" };
        assert.deepStrictEqual(t.filterEvent(event), event);
        assert.strictEqual(t.modno, 6);
        assert.strictEqual(t.maxId, 3);
    });

    it("drops changes that were already delivered", function () {
        const t = new OperationTracker();
        t.filterEvent({ updatedOperations: { operations: [op(3, 6)] }, event: "updatedOperations" });
        assert.strictEqual(t.filterEvent({ updatedOperations: { operations: [op(3, 6)] }, event: "updatedOperations" }), null);
        const mixed = t.filterEvent({ updatedOperations: { operations: [op(3, 5), op(4, 7)] }, event: "updatedOperations" });
        assert.deepStrictEqual(ids(mixed), ["4@7"]);
    });

    it("passes deleted events through", function () {
        const t = new OperationTracker();
        t.filterEvent({ createdOperations: { operations: [op(3, 6)] } });
        const del = { deletedOperations: { values: ["3"] }, event: "deletedOperations" };
        assert.deepStrictEqual(t.filterEvent(del), del);
        assert.ok(!t.seen.has("3"));
    });

    it("keeps the baseline when events already went past it", function () {
        const t = new OperationTracker();
        t.filterEvent({ updatedOperations: { operations: [op(9, 20)] } });
        t.setBaseline(15, 8);
        assert.strictEqual(t.modno, 20);
        assert.strictEqual(t.maxId, 9);
    });

    describe("catchUpEvents", function () {
        it("splits missed operations into new and changed ones", function () {
            const t = new OperationTracker();
            t.setBaseline(10, 5);
            t.filterEvent({ createdOperations: { operations: [op(6, 11, "STATUS_PENDING")] } });
            // While disconnected: 6 finished, an older operation (2) changed, and 7 was created.
            const events = t.catchUpEvents([op(7, 14), op(6, 13), op(2, 12)]);
            assert.strictEqual(events.length, 2);
            assert.strictEqual(events[0].event, "createdOperations");
            assert.deepStrictEqual(ids(events[0]), ["7@14"]);
            assert.strictEqual(events[1].event, "updatedOperations");
            assert.deepStrictEqual(ids(events[1]), ["2@12", "6@13"]);
            assert.ok(events.every(e => e.catchUp === true));
            assert.strictEqual(t.modno, 14);
            assert.strictEqual(t.maxId, 7);
        });

        it("leaves out changes the new stream already delivered", function () {
            const t = new OperationTracker();
            t.setBaseline(10, 5);
            // The reconnected stream delivered 6@12 before the catch-up query returned.
            t.filterEvent({ updatedOperations: { operations: [op(6, 12)] } });
            const events = t.catchUpEvents([op(6, 12), op(4, 11)]);
            assert.strictEqual(events.length, 1);
            assert.deepStrictEqual(ids(events[0]), ["4@11"]);
        });

        it("returns nothing when nothing was missed", function () {
            const t = new OperationTracker();
            t.setBaseline(10, 5);
            assert.deepStrictEqual(t.catchUpEvents([]), []);
        });
    });

    it("forgets the oldest operations beyond its limit", function () {
        const t = new OperationTracker(3);
        for (let i = 1; i <= 5; i++) t.filterEvent({ updatedOperations: { operations: [op(i, i)] } });
        assert.deepStrictEqual(Array.from(t.seen.keys()), ["3", "4", "5"]);
        assert.strictEqual(t.modno, 5);
    });
});
