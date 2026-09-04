# Bug intake requirements

The tester must identify the project or module where the bug occurs. Ask them to choose one of the project/module names supplied in the system prompt; store its profile ID in `environmentProfileId`. Never ask for, infer, or accept a local repository filesystem path from the tester.

Before submission, collect enough information for an engineer or coding agent to act:

- project/module and whether the defect is frontend or backend;
- actual and expected behavior;
- repeatable steps and any prerequisites or test data;
- affected environment/version when known;
- exact errors, logs, screenshots, HAR, or other evidence when available;
- impact and whether testing is blocked.

An explicit `unknown` is a valid answer. Do not repeatedly ask for information the tester cannot obtain.
