module.exports = function(RED) {
    function BackrestConfigNode(config) {
        RED.nodes.createNode(this, config);

        // Credentials (if necessary)
        if (this.credentials) {
            this.backrest_url = this.credentials.backrest_url.replace(/\/?$/, '');
            this.username = this.credentials.username;
            this.password = this.credentials.password;
        }
    }
    RED.nodes.registerType('backrest-config', BackrestConfigNode, {
        credentials: {
            backrest_url: { type: "text" },
            username: { type: 'text' },
            password: { type: 'password' }
        }
    });
};