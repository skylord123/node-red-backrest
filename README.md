# node-red-contrib-backrest

🚧 **Work in Progress** 🚧  
This Node-RED module allows communication with a [Backrest](https://github.com/garethgeorge/backrest) instance, enabling seamless integration of [restic-powered](https://restic.net/) backups into Node-RED flows.

## Features

- Manage Backrest repositories, snapshots, and backup operations within Node-RED.
- Execute restic commands through Backrest’s API.
- Monitor backup events and logs in real-time.
- Automate backup workflows with easy-to-use nodes.

## Installation

You can install via the palette manager in the Node-RED hamburger menu or you can install via terminal with this command:

```sh
npm install node-red-contrib-backrest
```

## Usage

This module provides Node-RED nodes for interacting with Backrest's API, including operations like:
- Retrieving and updating configuration
- Listing snapshots and repository files
- Performing backups, restores, and cleanup tasks
- Running custom restic commands
- Streaming logs and operation events

For a detailed example of how to use these nodes, check out the [examples directory](./examples).

## Goals for First Release

### ✅ Completed
- **Support for all non-streaming API endpoints**
  - `/v1.Backrest/GetConfig`
  - `/v1.Backrest/SetConfig`
  - `/v1.Backrest/GetOperations`
  - `/v1.Backrest/ListSnapshots`
  - `/v1.Backrest/ListSnapshotFiles`
  - `/v1.Backrest/Backup`
  - `/v1.Backrest/Restore`
  - `/v1.Backrest/Forget`
  - `/v1.Backrest/DoRepoTask`
  - `/v1.Backrest/RunCommand`
  - `/v1.Backrest/Cancel`
  - `/v1.Backrest/GetDownloadURL`
  - `/v1.Backrest/ClearHistory`
  - `/v1.Backrest/PathAutocomplete`
  - `/v1.Backrest/GetSummaryDashboard`
  - `/v1.Backrest/CheckRepoExists`
  - `/v1.Backrest/AddRepo`

- **Support for streaming API endpoints**
  - `/v1.Backrest/GetOperationEvents`
  - `/v1.Backrest/GetLogs`

### 🚧 In Progress
- [ ] Examples for all nodes
- [ ] New node(s) for easily setting up detailed webhooks

## Contributing

Contributions are welcome! If you'd like to add features, improve documentation, or fix bugs, feel free to open a PR or issue.