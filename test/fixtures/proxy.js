// A TCP proxy in front of Backrest that can be cut and restored, to simulate the
// connection between Node-RED and Backrest dropping while Backrest keeps running.
const net = require("net");

class CuttableProxy {
    constructor(targetUrl) {
        const target = new URL(targetUrl);
        this.targetHost = target.hostname;
        this.targetPort = Number(target.port);
        this.sockets = new Set();
        this.port = null;
        this.server = null;
    }

    async start() {
        await this.listen(0);
        this.url = `http://127.0.0.1:${this.port}`;
        return this;
    }

    listen(port) {
        this.server = net.createServer(client => {
            const upstream = net.connect(this.targetPort, this.targetHost);
            for (const s of [client, upstream]) {
                this.sockets.add(s);
                s.on("close", () => this.sockets.delete(s));
                s.on("error", () => {});
            }
            client.pipe(upstream);
            upstream.pipe(client);
        });
        return new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(port, "127.0.0.1", () => {
                this.port = this.server.address().port;
                resolve();
            });
        });
    }

    /** Drop every connection and refuse new ones. */
    async cut() {
        const closed = new Promise(resolve => this.server.close(() => resolve()));
        this.destroyAll(); // close() only finishes once open connections are gone
        await closed;
    }

    destroyAll() {
        for (const s of this.sockets) s.destroy();
        this.sockets.clear();
    }

    /** Accept connections again (on the same port). */
    restore() {
        return this.listen(this.port);
    }

    async stop() {
        this.destroyAll();
        if (this.server && this.server.listening) await new Promise(r => this.server.close(() => r()));
    }
}

module.exports = { CuttableProxy };
