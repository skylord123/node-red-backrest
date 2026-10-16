// Starts a throwaway Backrest server in Docker for the integration tests.
//
// The server gets basic auth (admin / testpass), one repository ("test-repo") and one
// plan ("test-plan") that backs up a few small files. Set BACKREST_IMAGE to test
// against a different Backrest version.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");

const IMAGE = process.env.BACKREST_IMAGE || "garethgeorge/backrest:v1.14.1";
const USERNAME = "admin";
const PASSWORD = "testpass";

let instance = null;

function docker(...args) {
    return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function hostPort(container, port) {
    // "0.0.0.0:49153\n[::]:49153" -> 49153
    return docker("port", container, port).split("\n")[0].split(":").pop();
}

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < end) {
        try {
            const result = await fn();
            if (result) return result;
        } catch (err) {
            lastErr = err;
        }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for ${what}${lastErr ? `: ${lastErr.message}` : ""}`);
}

class BackrestFixture {
    constructor() {
        this.id = `nrb-test-${process.pid}-${Date.now()}`;
        this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrb-test-"));
        this.username = USERNAME;
        this.password = PASSWORD;
        this.containers = [];
        this.network = null;
    }

    async start() {
        for (const d of ["config", "data", "cache", "repos", "source/sub"]) {
            fs.mkdirSync(path.join(this.dir, d), { recursive: true });
        }
        fs.writeFileSync(path.join(this.dir, "source/a.txt"), "hello world\n");
        fs.writeFileSync(path.join(this.dir, "source/sub/b.txt"), "second file\n");
        // Start with auth disabled so we can hash the password with Backrest itself.
        fs.writeFileSync(path.join(this.dir, "config/config.json"), JSON.stringify({
            modno: 1, version: 6, instance: "nrtest", auth: { disabled: true }
        }));

        this.network = this.id;
        docker("network", "create", this.network);
        const name = `${this.id}-backrest`;
        // Backrest runs as root in the container; make the mounted dirs writable either way.
        fs.chmodSync(this.dir, 0o777);
        docker("run", "-d", "--name", name, "--network", this.network, "--network-alias", "backrest",
            "-p", "127.0.0.1::9898",
            "-e", "BACKREST_PORT=0.0.0.0:9898",
            "-e", "BACKREST_DATA=/data",
            "-e", "BACKREST_CONFIG=/config/config.json",
            "-e", "XDG_CACHE_HOME=/cache",
            "-v", `${this.dir}/config:/config`,
            "-v", `${this.dir}/data:/data`,
            "-v", `${this.dir}/cache:/cache`,
            "-v", `${this.dir}/repos:/repos`,
            "-v", `${this.dir}/source:/source`,
            IMAGE);
        this.containers.push(name);
        this.url = `http://127.0.0.1:${hostPort(name, "9898")}`;

        await waitFor(() => this.raw("GetConfig", {}, false).then(() => true), 30000, "Backrest to start");

        const hash = await this.rawService("v1.Authentication", "HashPassword", { value: PASSWORD }, false);
        const config = await this.raw("GetConfig", {}, false);
        config.auth = { users: [{ name: USERNAME, passwordBcrypt: hash.value }] };
        await this.raw("SetConfig", config, false);

        await this.raw("AddRepo", { repo: { id: "test-repo", uri: "/repos/test", password: "repopass" } });
        await this.addPlan({ id: "test-plan", repo: "test-repo", paths: ["/source"] });
        this.repoGuid = (await this.raw("GetConfig")).repos.find(r => r.id === "test-repo").guid;
        return this;
    }

    async addPlan(plan) {
        const config = await this.raw("GetConfig");
        config.plans = (config.plans || []).filter(p => p.id !== plan.id);
        config.plans.push({ schedule: { disabled: true }, ...plan });
        return this.raw("SetConfig", config);
    }

    /** Start Caddy as an HTTPS reverse proxy in front of Backrest, using its internal CA. */
    async startTlsProxy() {
        if (this.tlsUrl) return this;
        const caddyDir = path.join(this.dir, "caddy");
        fs.mkdirSync(caddyDir, { recursive: true });
        fs.writeFileSync(path.join(caddyDir, "Caddyfile"),
            "{\n\tauto_https disable_redirects\n}\nhttps://localhost:443 {\n\ttls internal\n\treverse_proxy h2c://backrest:9898\n}\n");
        const name = `${this.id}-caddy`;
        docker("run", "-d", "--name", name, "--network", this.network,
            "-p", "127.0.0.1::443",
            "-v", `${caddyDir}/Caddyfile:/etc/caddy/Caddyfile`,
            process.env.CADDY_IMAGE || "caddy:2");
        this.containers.push(name);
        this.tlsUrl = `https://localhost:${hostPort(name, "443")}`;
        this.tlsCa = await waitFor(() => {
            try {
                return docker("exec", name, "cat", "/data/caddy/pki/authorities/local/root.crt");
            } catch (err) {
                return null;
            }
        }, 30000, "Caddy to create its CA");
        return this;
    }

    raw(method, body = {}, auth = true) {
        return this.rawService("v1.Backrest", method, body, auth);
    }

    async rawService(service, method, body, auth = true) {
        const res = await axios.post(`${this.url}/${service}/${method}`, body, {
            headers: { "Content-Type": "application/json" },
            auth: auth ? { username: USERNAME, password: PASSWORD } : undefined
        });
        return res.data;
    }

    /** Wait until an operation reaches a final status and return it. */
    async waitForOperation(id, timeoutMs = 60000) {
        return waitFor(async () => {
            const res = await this.raw("GetOperations", { selector: { ids: [String(id)] } });
            const op = (res.operations || [])[0];
            return op && !["STATUS_PENDING", "STATUS_INPROGRESS"].includes(op.status) ? op : null;
        }, timeoutMs, `operation ${id} to finish`);
    }

    stop() {
        for (const name of this.containers.reverse()) {
            try { docker("rm", "-f", name); } catch (err) { /* already gone */ }
        }
        if (this.network) {
            try { docker("network", "rm", this.network); } catch (err) { /* already gone */ }
        }
        try {
            // Files written by the container are owned by root; remove them from inside Docker.
            docker("run", "--rm", "-v", `${this.dir}:/d`, "--entrypoint", "sh", IMAGE, "-c", "rm -rf /d/*");
        } catch (err) { /* best effort */ }
        fs.rmSync(this.dir, { recursive: true, force: true });
    }
}

/** Shared Backrest instance, started on first use and stopped by the root hook. */
async function getBackrest() {
    if (!instance) {
        instance = new BackrestFixture();
        try {
            await instance.start();
        } catch (err) {
            instance.stop();
            instance = null;
            throw err;
        }
    }
    return instance;
}

function stopBackrest() {
    if (instance) {
        instance.stop();
        instance = null;
    }
}

module.exports = { getBackrest, stopBackrest, waitFor };
