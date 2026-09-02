# Backend runtime skill

Behavior rules for a backend fixer:

1. Reproduce the reported behavior and inspect the existing service boundaries.
2. Parameterize database inputs and preserve API compatibility.
3. Handle errors at the established middleware boundary; do not hide failures.
4. Do not deploy, push, or merge, and keep secrets out of logs.
