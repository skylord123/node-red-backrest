Examples
---

Each file shows one node. Import them from the Node-RED menu under **Import > Examples > @skylord123/node-red-contrib-backrest**, or copy a file's contents and paste it into **Import**. All examples share the same **Example** server config node: open it and enter your Backrest URL and login. Nodes that pick a plan, repository or operation from your server show the list once the server is set up.

### [Run Backup](Run%20Backup.json)

Back up a plan and report the result, a dry run with the plan taken from the message, and a nightly backup that sends an alert when it fails.

![Run Backup example](Run%20Backup.png)

### [Backup Status](Backup%20Status.json)

Check every hour and alert only when a plan needs attention, the status of one plan, and every repository as one list.

![Backup Status example](Backup%20Status.png)

### [Operation Events](Operation%20Events.json)

Every finished backup, the status changes of one plan, live backup progress, and subscribing on demand to Backrest's raw events.

![Operation Events example](Operation%20Events.png)

### [Get Logs](Get%20Logs.json)

The log of an operation picked in the editor, the output of a restic command run through the API node, and the log of a backup after it finishes.

![Get Logs example](Get%20Logs.png)

### [Backrest Hooks](Backrest%20Hooks.json)

Pause a service while a backup runs: Backrest calls Node-RED before each backup of a plan and waits for it, and cancels the backup if Node-RED reports an error. A second call tells Node-RED when the backup has finished. The "Backrest setup" comment node has the hook commands to add to the plan in Backrest. This example uses only core Node-RED nodes.

![Backrest Hooks example](Backrest%20Hooks.png)

### [API](API.json)

Calls to many API endpoints: the config, the dashboard summary, operations, snapshots and their files, path autocomplete, and running a restic command.

![API example](API.png)
