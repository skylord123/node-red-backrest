// Root hooks: start the Node-RED test server once and clean up Docker at the end.
const { helper } = require("./fixtures/nodered");
const { stopBackrest } = require("./fixtures/backrest");

exports.mochaHooks = {
    beforeAll(done) {
        helper.startServer(done);
    },
    async afterEach() {
        await helper.unload();
    },
    afterAll(done) {
        stopBackrest();
        helper.stopServer(done);
    }
};
