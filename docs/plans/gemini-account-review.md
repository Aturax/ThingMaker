# Gemini accounts: PR #12 review follow-up

Review: https://github.com/Monteseu/ThingMaker/pull/12

## Changes

| Review point | Implementation |
| --- | --- |
| Isolation can silently fall back to the app's keychain | Before login and account use, an empty temporary profile must produce the installed CLI's signed-out response. Unexpected responses fail closed. Account status, models, quota, suggestions, initial sessions and relaunches also require a real, nonempty private token file. Finishing login surfaces the isolation error. |
| Whole-home mirroring and recursive Library/AppData links | Profiles now contain only the provider's explicit configuration links. Legacy links into the real home are removed without following them; unrelated user links are preserved. Print-mode agy 1.5.9 rejects the ACP-only `--gemini-dir` flag. Tools use the private home and retain their usual Rustup, Cargo and global Git configuration paths. Files and links created at its root survive account removal. |
| Atomic saves can replace shared file links | Configuration and conversation directories are shared. Shared settings/keybindings files track their last synchronized content hash: a one-sided atomic save is propagated and relinked, while conflicting edits keep the main file and move the other version to a timestamped backup in the profile root. Providers shows the backup path. Source permissions are preserved. |
| Windows link creation requires Developer Mode | Gemini uses NTFS junctions for directories and hard links for existing shared files. Setup errors propagate and cannot select the main account by accident. Mixed-case Windows environment names cannot override explicit profile paths. APPDATA and LOCALAPPDATA are redirected too. |
| Partial sharing | Share config (including plugins and config.json), skills, commands, trustedFolders.json and projects.json. Newly created shared files are published on the next preparation. Existing private config directories are preserved under `.before-sharing`. Only existing, known non-credential CLI directories are linked; its token, cache, onboarding state and logs stay private. |
| Login terminal leaks through listing/export | Authentication terminals are excluded from terminal listings and native export refuses them. Repeated subscriptions replay the login prompt. Recording stops before forwarding the first input to the terminal. Closing clears private scrollback. |
| Login survives renderer reload | Native reload cleanup closes private terminals. A generation lock also prevents a pending login preparation from creating an orphan after reload. Added accounts use `agy acp --login`, which only authenticates and then exits. |
| Removing a token without native sign-out | Additional accounts use agy's native ACP logout capability. Removal skips settings preparation and checks that logout cleared the private token. If logout fails, the user can explicitly confirm local removal after seeing that Google access remains authorized. Invalid credentials are not reported as successfully signed out. The default account cannot be signed out here. |
| Missing account identity | When additional Gemini accounts exist, read email and plan from agy's documented status-line payload. Failure to obtain this optional metadata does not invent an identity. |

Google authentication and CLI first-run setup are separate stages. `setupRequired` is an optional status field; the UI continues into the CLI setup terminal after OAuth or offers **Finish setup** for an already authenticated account. Color, terms and data-use choices remain the user's. Probes ignore initializing status-line frames until the requested email or usable quota is present. Duplicate completion requests and stale responses after cancellation are rejected.

The CLI credential is `.gemini/antigravity-cli/antigravity-oauth-token`: **the antigravity-cli root must never be a shared link**. Sharing it would share credentials too. Known conversation/content subdirectories are shared individually; unknown files remain private. Old whole-directory links are removed without copying their credentials. Legacy standalone prototype credentials are rejected rather than mixed with the new layout or removed without explicit local-removal confirmation.

## File-only authentication without SSH inheritance

No synthetic SSH variables are set for login, probes, logout, sessions or their tools. Before each process starts, ThingMaker refreshes the account's `antigravity-keyring-unavailable` cache entries under both `.gemini/cache` and `.gemini/antigravity-cli/cache`, covering the provider's two storage constructors. In agy 1.5.9 this selects file-only token storage for the process lifetime. Entries are refreshed before each launch/relaunch and before forwarding input in the authentication terminal, so a long pause in the browser or setup wizard does not expire the backend selection before confirmation.

The marker is an **internal CLI contract**, not a documented configuration flag. Additional accounts therefore require the explicitly verified CLI version 1.5.9, plus an empty-profile probe before use. Successful checks are cached by executable path and modification time. Unknown versions, unexpected probe responses, shared cache-directory links and missing private tokens are rejected. The main account does not use this mechanism. Supporting another CLI version requires verifying its backend behavior and updating the compatibility gate.

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

The [Windows compatibility workflow passed](https://github.com/Monteseu/ThingMaker/actions/runs/43901436720) on code commit `bb8544b`. It runs TypeScript/frontend checks and builds, focused native profile/environment/terminal tests with Developer Mode disabled, plus an unsigned probe against the official Windows agy 1.5.9 executable verified by its published SHA512. Workflow syntax was checked with actionlint. Windows execution exposed and verified fixes for ordinary NTFS folders, removing the empty directory left after clearing a junction, and unblocking ConPTY's initial cursor handshake before closing a private terminal whose renderer has gone away.

`cargo clippy --workspace --all-targets -- -D warnings` still fails on two unchanged baseline test warnings: `type_complexity` in `crates/thingmaker-supervisor/tests/local_chat.rs:22` and `cloned_ref_to_slice_refs` in `apps/desktop/src-tauri/src/commands/screen_tools.rs:606`. Both were confirmed in the PR's original HEAD; they are outside this change.

Real macOS validation used two different Google accounts on agy 1.5.9. The user completed OAuth and the CLI's first-run choices. Both emails and the selected account's quota are visible. The additional account executed an actual read-only shell command with no synthetic SSH variables, then the same conversation resumed on the main account and retained its validation marker. The main account identity remained unchanged. The repeatable opt-in test is `isolated_account_switch_preserves_context_and_clean_tool_environment` in `tests/real_gemini.rs`; it takes the private profile from `THINGMAKER_REAL_GEMINI_ACCOUNT_HOME` and requires `THINGMAKER_REAL_GEMINI=1`.

Native logout/removal also passed in the running macOS app: only the added test account disappeared, its token and private provider directory were removed, a user-created file at the profile root remained, shared conversations remained, and the main account stayed connected with its original identity.

## Acceptance and regression checklist

On macOS, then Windows with Developer Mode disabled:

1. Start with the main account signed in. Add another Gemini account and manually complete Google's sign-in and any CLI terms. Finish sign-in in ThingMaker. Confirm the two account entries display the expected emails.
2. Check that the added account has its own `.gemini/antigravity-cli/antigravity-oauth-token` and the main app is still signed into its original account. Switch accounts and resume a conversation.
3. Confirm model catalogs and quota follow the selected account. Verify settings, MCP configuration and plugins remain shared after a save that uses a temporary file and rename.
4. While signing in, check that normal terminal listing/export cannot expose that terminal. Reload the renderer and verify the login process is terminated, including a reload while preflight is pending.
5. Have a tool create a file in the private home. Remove the account: native logout must succeed, its private token must disappear, the main account must remain signed in, and the created file must remain available.

The macOS checklist above has been exercised. Windows CI previously passed the unsigned CLI check. During local Windows review on 19 November 2026, the SHA512-verified 1.5.9 executable listed 23 models from an empty private profile. The preflight rejected this response and blocked sign-in. The cause of the visible catalog is unverified. Real second-account Google OAuth on Windows remains unverified.
