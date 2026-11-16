# Gemini accounts: PR #12 review follow-up

Review: https://github.com/Monteseu/ThingMaker/pull/12

## Changes

| Review point | Implementation |
| --- | --- |
| Isolation can silently fall back to the app's keychain | Before login and account use, an empty temporary profile must produce the installed CLI's signed-out response. Unexpected responses fail closed. Account status, models, quota, suggestions, initial sessions and relaunches also require a real, nonempty private token file. Finishing login surfaces the isolation error. |
| Whole-home mirroring and recursive Library/AppData links | Profiles now contain only the provider's explicit configuration links. Legacy links into the real home are removed without following them; unrelated user links are preserved. Tools still use the private home, as described in Providers. Files and links created at its root survive account removal. |
| Atomic saves can replace shared file links | Configuration and conversation directories are shared. Shared settings/keybindings files track their last synchronized content hash: a one-sided atomic save is propagated and relinked, while conflicting edits preserve both versions and report an error. Source permissions are preserved. |
| Windows link creation requires Developer Mode | Gemini uses NTFS junctions for directories and hard links for existing shared files. Setup errors propagate and cannot select the main account by accident. Mixed-case Windows environment names cannot override explicit profile paths. APPDATA and LOCALAPPDATA are redirected too. |
| Partial sharing | Share config (including plugins and config.json), skills, commands, trustedFolders.json and projects.json. Newly created shared files are published on the next preparation. Existing private config directories are preserved under `.before-sharing`. Only known non-credential CLI directories are linked; its token, cache, onboarding state and logs stay private. |
| Login terminal leaks through listing/export | Authentication terminals are excluded from terminal listings and native export refuses them. Initial output is consumed once; live authentication output is not retained in supervisor scrollback. Closing clears private scrollback. |
| Login survives renderer reload | Native reload cleanup closes private terminals. A generation lock also prevents a pending login preparation from creating an orphan after reload. Added accounts use `agy acp --login`, which only authenticates and then exits. |
| Removing a token without native sign-out | Additional accounts use agy's native ACP logout capability. Removal requires successful logout and confirmation that the private token is gone; failures retain the account. Invalid credentials are not reported as successfully signed out. The default account cannot be signed out here. |
| Missing account identity | Read email and plan from agy's documented status-line payload, without reading credentials. Failure to obtain this optional metadata does not invent an identity. |

Google authentication and CLI first-run setup are separate stages. `setupRequired` is an optional status field; the UI continues into the CLI setup terminal after OAuth or offers **Finish setup** for an already authenticated account. Color, terms and data-use choices remain the user's. Probes ignore initializing status-line frames until the requested email or usable quota is present. Duplicate completion requests and stale responses after cancellation are rejected.

The CLI credential is `.gemini/antigravity-cli/antigravity-oauth-token`: **the antigravity-cli root must never be a shared link**. Sharing it would share credentials too. Known conversation/content subdirectories are shared individually; unknown files remain private. Old whole-directory links are removed without copying their credentials. Legacy standalone prototype credentials are rejected rather than mixed with the new layout or deleted without native sign-out.

## File-only authentication without SSH inheritance

No synthetic SSH variables are set for login, probes, logout, sessions or their tools. Before each process starts, ThingMaker refreshes the account's `antigravity-keyring-unavailable` cache entries under both `.gemini/cache` and `.gemini/antigravity-cli/cache`, covering the provider's two storage constructors. In agy 1.5.9 this selects file-only token storage for the process lifetime. Entries are refreshed before each launch/relaunch and before forwarding input in the authentication terminal, so a long pause in the browser or setup wizard does not expire the backend selection before confirmation.

The marker is an **internal CLI contract**, not a documented configuration flag. Additional accounts therefore require the explicitly verified CLI version 1.5.9, plus an empty-profile probe before use. Unknown versions, unexpected probe responses, shared cache-directory links and missing private tokens are rejected. The main account does not use this mechanism. Supporting another CLI version requires verifying its backend behavior and updating the compatibility gate.

A regression test launches an account, runs an actual child process to inspect its environment, deliberately expires the marker, then changes model to force a resumed process. Both launches must refresh file storage and give child tools no SSH variables.

This is isolation of provider authentication, not a security boundary against arbitrary code running as the user. The preflight detects observed fallback behavior and token checks catch missing local credentials; they cannot prove every future CLI implementation will leave the shared keychain untouched during OAuth.

ACP is explicitly anchored to the private Gemini directory. Its app-data argument is the relative subdirectory `antigravity-cli`, as required by its language-server startup; passing an absolute app-data path is rejected by the installed CLI.

## Validation

Automated validation covers token presence/type, rejection of shared-auth and unknown preflight responses, sharing across atomic config saves, legacy loop cleanup, preservation of user files and links, split-file detection, profile setup failures, terminal privacy and process cleanup, native logout failures/success through a mock ACP peer, public identity parsing, and displaying isolation failures in the interface.

Run:

```sh
cargo test --workspace
pnpm --filter @thingmaker/desktop test
pnpm typecheck
cargo clippy --workspace --lib --bins -- -D warnings
pnpm --filter @thingmaker/desktop build:vite
```

Local results on 2026-11-16: 518 workspace Rust tests passed (12 opt-in tests ignored), 610 desktop tests passed, workspace TypeScript checks passed, and production Clippy passed with warnings denied. Desktop and remote production assets and a separate debug macOS application bundle built successfully. The full native suite is run separately from application packaging, since concurrent packaging can replace Tauri's shared library artifact during rustdoc execution. Frontend tests are run with four workers to avoid unrelated timeouts under concurrent compilation load.

The running debug application was also exercised through its actual native commands and UI: private login terminals do not appear in `terminal_list`, `terminal_export` rejects them, a renderer reload terminates their processes, premature sign-in confirmation reports the missing isolated token, cancellation terminates login, and retry starts a new authentication-only process. The main account remains connected with its original email.

`.github/workflows/gemini-accounts.yml` prepares Windows validation on pull requests: TypeScript/frontend checks and builds, focused native profile/environment/terminal tests with Developer Mode disabled, plus an unsigned probe against the official Windows agy 1.5.9 executable verified by its published SHA512. Workflow syntax was checked with actionlint. **The workflow has not run yet: these local changes have not been pushed.** It does not claim to replace real second-account OAuth on Windows.

`cargo clippy --workspace --all-targets -- -D warnings` still fails on two unchanged baseline test warnings: `type_complexity` in `crates/thingmaker-supervisor/tests/local_chat.rs:22` and `cloned_ref_to_slice_refs` in `apps/desktop/src-tauri/src/commands/screen_tools.rs:606`. Both were confirmed in the PR's original HEAD; they are outside this change.

Real macOS validation used two different Google accounts on agy 1.5.9. The user completed OAuth and the CLI's first-run choices. Both emails and the selected account's quota are visible. The additional account executed an actual read-only shell command with no synthetic SSH variables, then the same conversation resumed on the main account and retained its validation marker. The main account identity remained unchanged. The repeatable opt-in test is `isolated_account_switch_preserves_context_and_clean_tool_environment` in `tests/real_gemini.rs`; it takes the private profile from `THINGMAKER_REAL_GEMINI_ACCOUNT_HOME` and requires `THINGMAKER_REAL_GEMINI=1`.

## Remaining acceptance and regression checklist

On macOS, then Windows with Developer Mode disabled:

1. Start with the main account signed in. Add another Gemini account and manually complete Google's sign-in and any CLI terms. Finish sign-in in ThingMaker. Confirm the two account entries display the expected emails.
2. Check that the added account has its own `.gemini/antigravity-cli/antigravity-oauth-token` and the main app is still signed into its original account. Switch accounts and resume a conversation.
3. Confirm model catalogs and quota follow the selected account. Verify settings, MCP configuration and plugins remain shared after a save that uses a temporary file and rename.
4. While signing in, check that normal terminal listing/export cannot expose that terminal. Reload the renderer and verify the login process is terminated, including a reload while preflight is pending.
5. Have a tool create a file in the private home. Remove the account: native logout must succeed, its private token must disappear, the main account must remain signed in, and the created file must remain available.

At this checkpoint, signed-in native logout/removal and the hosted Windows workflow remain pending. Windows CI needs no Google credentials; a real second-account OAuth flow on Windows is not claimed by the unsigned CLI probe.
