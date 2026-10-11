# OMP

T3 Code uses your installed [OMP](https://omp.sh) runtime and its native model providers,
credentials, project configuration, and session history.

## Set Up OMP

1. Install OMP 18.8.5 or newer and Bun on the machine running the T3 Code server.
2. Run `omp`, then `/login` to connect a model provider, or configure that provider's API key.
3. Open **Settings → Providers**, add an OMP instance, enable it, and choose **Refresh**.

If `omp` is not on the server's `PATH`, set **Binary path** to its executable. On Windows this
can be the installed `omp.cmd`. Set **Profile** to use a named native profile; leave it empty
to use OMP's current default profile. Each instance has its own environment settings.

You can also sign in from the provider settings. **Sign in with OMP** opens the native sign-in
terminal. Refreshing the provider discovers its available sign-in methods. On a remote server,
you can run `omp` and complete sign-in over SSH on that machine.

## Models and Project Configuration

Choose a discovered model and its supported **Thinking** level in the composer. The default
model selection follows the selected OMP profile. Leaving Thinking at its default preserves
the model's native configuration.

Background checks read OMP's model and skill catalogs without opening an agent session. Use
**Refresh** in provider settings to discover extension-provided models and the full slash-command
catalog for workspaces opened in T3 Code. OMP loads its normal project configuration when a
conversation starts.

Discovered skills appear in the composer's `$` menu. Native commands appear in the `/` menu.
OMP's questions and tool approvals use the existing conversation controls.

## Native Sessions

Threads use native OMP session files for resume, rollback, and same-instance forks. A fork
creates an independent conversation through the selected message in the destination workspace.
Switching providers uses portable conversation context.

The welcome wizard imports existing OMP conversations for enabled OMP instances. Continuing an
imported conversation resumes its native session file, so OMP keeps its full context.

Native subagents appear in the shared subagent view, and each child's thread shows its activity.
The Stop control targets the selected task while the rest of the run continues.

## Permission Modes

OMP enforces the selected mode through its native approval policy:

- **Supervised** allows read-only tools and requests approval for write and execution tools.
- **Auto-accept edits** also allows write-tier tools and requests approval for execution tools.
- **Full access** permits all three tool tiers.

Your OMP per-tool policies and extension trust settings still apply. Approval requests offer
**Allow** and **Deny** for the current request. Task questions remain available in every mode.

## Troubleshooting

- If OMP is unavailable, run the configured binary on the server machine and refresh the provider.
- If models are missing, confirm the selected native profile and its model credentials in OMP.
- If an extension command is missing, open its workspace in T3 Code and refresh the provider.
- If sign-in status is unknown, refresh the provider to read the native profile's authentication
  status, or open OMP directly to complete sign-in.
