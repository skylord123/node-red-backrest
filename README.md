# node-red-contrib-backrest

WIP module for communicating with a Backrest instance using Node-RED.

Example for how to use this can be found [here](./examples)

### Goals for first release

- [ ] Examples for all nodes
- [ ] New node(s) that make setting up webhooks incredibly easy and detailed
- [x] All non-stream endpoints added
  - [x] /v1.Backrest/GetConfig
  - [x] /v1.Backrest/SetConfig
  - [x] /v1.Backrest/GetOperations
  - [x] /v1.Backrest/ListSnapshots
  - [x] /v1.Backrest/ListSnapshotFiles
  - [x] /v1.Backrest/Backup
  - [x] /v1.Backrest/Restore
  - [x] /v1.Backrest/Forget
  - [x] /v1.Backrest/DoRepoTask
  - [x] /v1.Backrest/RunCommand
  - [x] /v1.Backrest/Cancel
  - [x] /v1.Backrest/GetDownloadURL
  - [x] /v1.Backrest/ClearHistory
  - [x] /v1.Backrest/PathAutocomplete
  - [x] /v1.Backrest/GetSummaryDashboard
  - [x] /v1.Backrest/CheckRepoExists
  - [x] /v1.Backrest/AddRepo
- [x] New node for endpoints that stream data
  - [x] /v1.Backrest/GetOperationEvents
  - [x] /v1.Backrest/GetLogs
