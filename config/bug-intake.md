# Bug intake requirements

The tester should describe the project or module where the bug occurs in natural language. If an existing project profile is supplied in the system context, it may be reused by its internal ID. Otherwise ask for the project's Git remote clone URL (HTTPS or SSH), and ask which side is affected (frontend or backend) and the default branch when known. Do not ask for a local repository filesystem path. The service uses the confirmed remote to clone into `DATA_ROOT/repositories` and generates the runnable profile in `DATA_ROOT/generated-environments.yaml` after the tester submits the report.

Before submission, collect enough information for an engineer or coding agent to act:

- project/module and whether the defect is frontend or backend;
- HTTPS or SSH Git clone URL when no existing project profile applies;
- default branch when known (the service uses `main` when it is not supplied);
- actual and expected behavior;
- repeatable steps and any prerequisites or test data;
- affected environment/version when known;
- exact errors, logs, screenshots, HAR, or other evidence when available;
- impact and whether testing is blocked.

`setupCommands` and `validationCommands` are optional. Include them only when the tester provides known, repository-appropriate commands; never invent commands or claim that an empty list proves the fix. With no configured commands, the Pi Fixer may inspect the repository and run suitable checks available there, and the Pi Reviewer evaluates the patch and evidence, but neither outcome is guaranteed.

An explicit `unknown` is a valid answer. Do not repeatedly ask for information the tester cannot obtain.
