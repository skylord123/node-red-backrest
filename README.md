# node-red-contrib-backrest

WIP module for communicating with a Backrest instance using Node-RED.

Example for how to use this can be found [here](./examples)

### WIP List for first release

- [ ] All non-stream endpoints added, tested, and examples added
  - [x] /v1.Backrest/GetConfig
  - [ ] /v1.Backrest/SetConfig
  - [x] /v1.Backrest/GetOperations
  - [ ] /v1.Backrest/GetOperationEvents
  - [ ] /v1.Backrest/ListSnapshots
  - [ ] /v1.Backrest/ListSnapshotFiles
  - [ ] /v1.Backrest/Backup
  - [ ] /v1.Backrest/Restore
  - [ ] /v1.Backrest/Forget
  - [ ] /v1.Backrest/DoRepoTask
  - [ ] /v1.Backrest/RunCommand
  - [ ] /v1.Backrest/Cancel
  - [ ] /v1.Backrest/GetLogs
  - [ ] /v1.Backrest/GetDownloadURL
  - [ ] /v1.Backrest/ClearHistory
  - [ ] /v1.Backrest/PathAutocomplete
  - [ ] /v1.Backrest/GetSummaryDashboard
  - [ ] /v1.Backrest/CheckRepoExists
  - [ ] /v1.Backrest/AddRepo
- [ ] New node for endpoints that stream data (such as the `GetOperationEvents` and `GetLogs`)
- [ ] New node(s) that make setting up webhooks incredibly easy and detailed

