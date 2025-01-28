module.exports = function(RED) {
    function BackrestConfigNode(config) {
        RED.nodes.createNode(this, config);

        this.host = config.host;
        this.port = config.port;

        // Credentials (if necessary)
        if (this.credentials) {
            this.username = this.credentials.username;
            this.password = this.credentials.password;
        }
    }
    RED.nodes.registerType('backrest-config', BackrestConfigNode, {
        credentials: {
            username: { type: 'text' },
            password: { type: 'password' }
        }
    });
};