# Bug intake requirements

The minimum handoff contract is four facts: what actually happened, what should have happened, the project/module name, and the project's Git remote clone URL. Every report must include the remote URL (HTTPS or SSH) in the current draft. An existing project profile or its internal ID may identify the project/module, but it never satisfies or replaces the repository URL requirement. Do not ask for a local repository filesystem path. The service uses the confirmed remote to clone into `DATA_ROOT/repositories` and generates the runnable profile in `DATA_ROOT/generated-environments.yaml` after the tester submits the report.

Frontend/backend target, default branch, reproduction steps, route, browser/version, logs, screenshots, impact and other environment details are useful enhancements. Ask for them only when helpful, and never block confirmation or FixWorker handoff when the four minimum facts are present. If a dynamic environment must be provisioned, the service may still require a target/profile at submission time.

Before submission, collect enough information for an engineer or coding agent to act:

- project/module and whether the defect is frontend or backend;
- HTTPS or SSH Git clone URL for every report, including when an existing project profile applies;
- default branch when known (the service uses `main` when it is not supplied);
- actual and expected behavior;
- repeatable steps and any prerequisites or test data;
- affected environment/version when known;
- exact errors, logs, screenshots, HAR, or other evidence when available;
- impact and whether testing is blocked.

`setupCommands` and `validationCommands` are optional. Include them only when the tester provides known, repository-appropriate commands; never invent commands or claim that an empty list proves the fix. With no configured commands, the Pi Fixer may inspect the repository and run suitable checks available there, and the Pi Reviewer evaluates the patch and evidence, but neither outcome is guaranteed.

An explicit `unknown` is a valid answer. Do not repeatedly ask for information the tester cannot obtain.

## Title convention

Generate the title from confirmed facts using the exact format `[module-name]-[problem symptom]`. The module name must identify the affected project/module, and the problem part must concisely describe the observable failure. Do not use greetings, generic wording such as `test`, `bug`, `页面问题`, suspected root causes, or proposed fixes. If later messages make an earlier title obsolete or reveal that it was only a placeholder, replace it automatically before confirmation and submission.
