//! Running `sl`. Port of `getExecParams` in `addons/isl-server/src/commands.ts`.
//!
//! Every flag and every environment variable here is upstream's; none is guessable from
//! watching `sl` run, and getting one wrong fails silently — an editor that blocks, a
//! locale that reorders output, a blackbox that fills with our own reads.
//!
//! As in `tscode-git`, `sl` is invoked with an argv array and never a shell string.

use std::path::Path;

use tscode_proc::Run;

use crate::error::Result;

/// The command upstream calls `ctx.cmd`. It is configurable in ISL; here it is whatever
/// `sl` the user's PATH resolves.
const SL: &str = "sl";

/// Reads that would otherwise spam the blackbox with our own polling.
/// Port of `EXCLUDE_FROM_BLACKBOX_COMMANDS`.
const EXCLUDE_FROM_BLACKBOX_COMMANDS: [&str; 6] =
    ["cat", "config", "diff", "log", "show", "status"];

/// The argv and environment one `sl` invocation runs with. Separated from the spawn so
/// the recipe can be asserted without a subprocess.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ExecParams {
    pub args: Vec<String>,
    /// `None` unsets the variable — upstream's `EDITOR: undefined`.
    pub env: Vec<(&'static str, Option<String>)>,
}

/// Port of `getExecParams`, minus its `ipc` branch: there is no node-ipc progress
/// renderer to talk to here.
pub(crate) fn exec_params(args: &[&str]) -> ExecParams {
    let mut out: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    out.push("--noninteractive".to_owned());

    // commit/amend have unconventional ways of escaping slashes from messages, so
    // upstream 'unescapes' them again. `expandHomeDir` is not supported on Windows.
    if !cfg!(windows) {
        for arg in &mut out {
            *arg = arg.replace("\\\\", "\\");
        }
    }

    let command_name = args.first().copied().unwrap_or_default();
    if EXCLUDE_FROM_BLACKBOX_COMMANDS.contains(&command_name) {
        out.push("--config".to_owned());
        out.push("extensions.blackbox=!".to_owned());
    }
    if command_name == "status" {
        // Take a lock when running status so that multiple status calls in parallel
        // don't overload watchman.
        out.push("--config".to_owned());
        out.push("fsmonitor.watchman-query-lock=True".to_owned());
    }

    // The command is non-interactive, so do not even attempt to run an editor.
    let editor = if cfg!(windows) { "exit /b 1" } else { "false" };
    let env = vec![
        // TODO: remove when SL_ENCODING is used everywhere — upstream's own note.
        ("HGENCODING", Some("UTF-8".to_owned())),
        ("SL_ENCODING", Some("UTF-8".to_owned())),
        // Override any custom aliases the user has defined.
        ("SL_AUTOMATION", Some("true".to_owned())),
        // Allow looking up diff numbers even in plain mode, constructing the `.git/sl`
        // repo regardless of the identity, and setting ui.username automatically.
        (
            "SL_AUTOMATION_EXCEPT",
            Some("ghrevset,phrevset,progress,sniff,username".to_owned()),
        ),
        ("EDITOR", None),
        ("VISUAL", None),
        ("HGUSER", None),
        ("HGEDITOR", Some(editor.to_owned())),
        ("LANG", Some(lang())),
    ];

    ExecParams { args: out, env }
}

/// The inherited `LANG`, or `C.UTF-8` when it is absent or names a non-UTF-8 encoding.
fn lang() -> String {
    match std::env::var("LANG") {
        Ok(lang) if lang.to_uppercase().ends_with("UTF-8") => lang,
        _ => "C.UTF-8".to_owned(),
    }
}

/// Run `sl` in `cwd` with `args` and return its stdout.
pub(crate) async fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    let params = exec_params(args);

    let mut run = Run::new(SL, params.args);
    let command = run.command();
    command.current_dir(cwd);
    for (key, value) in &params.env {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }

    let stdout = run.output(None).await?;
    Ok(strip_final_newline(
        String::from_utf8_lossy(&stdout).into_owned(),
    ))
}

/// `stripFinalNewline`, which `ejeca` applies to every result upstream reads.
fn strip_final_newline(mut value: String) -> String {
    if value.ends_with('\n') {
        value.pop();
        if value.ends_with('\r') {
            value.pop();
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(params: &ExecParams, key: &str) -> Option<Option<String>> {
        params
            .env
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value.clone())
    }

    #[test]
    fn every_invocation_is_noninteractive() {
        let params = exec_params(&["root", "--dotdir"]);
        assert_eq!(params.args, ["root", "--dotdir", "--noninteractive"]);
    }

    #[test]
    fn reads_are_kept_out_of_the_blackbox() {
        assert_eq!(
            exec_params(&["log", "--rev", "."]).args,
            ["log", "--rev", ".", "--noninteractive", "--config", "extensions.blackbox=!"]
        );
        // `root` is not in the exclusion set, so it gets no `--config`.
        assert_eq!(exec_params(&["root"]).args, ["root", "--noninteractive"]);
    }

    #[test]
    fn status_also_takes_the_watchman_query_lock() {
        assert_eq!(
            exec_params(&["status"]).args,
            [
                "status",
                "--noninteractive",
                "--config",
                "extensions.blackbox=!",
                "--config",
                "fsmonitor.watchman-query-lock=True",
            ]
        );
    }

    #[test]
    fn the_editor_is_unset_and_hgeditor_fails_instead() {
        let params = exec_params(&["log"]);

        assert_eq!(env_of(&params, "EDITOR"), Some(None));
        assert_eq!(env_of(&params, "VISUAL"), Some(None));
        assert_eq!(env_of(&params, "HGUSER"), Some(None));
        assert_eq!(
            env_of(&params, "HGEDITOR"),
            Some(Some(
                if cfg!(windows) { "exit /b 1" } else { "false" }.to_owned()
            ))
        );
    }

    #[test]
    fn the_encoding_and_automation_environment_is_upstreams() {
        let params = exec_params(&["log"]);

        assert_eq!(env_of(&params, "HGENCODING"), Some(Some("UTF-8".to_owned())));
        assert_eq!(env_of(&params, "SL_ENCODING"), Some(Some("UTF-8".to_owned())));
        assert_eq!(env_of(&params, "SL_AUTOMATION"), Some(Some("true".to_owned())));
        assert_eq!(
            env_of(&params, "SL_AUTOMATION_EXCEPT"),
            Some(Some("ghrevset,phrevset,progress,sniff,username".to_owned()))
        );
    }

    #[test]
    fn lang_is_normalised_to_a_utf8_locale() {
        let lang = env_of(&exec_params(&["log"]), "LANG").flatten().expect("LANG");
        assert!(
            lang.to_uppercase().ends_with("UTF-8"),
            "LANG should name a UTF-8 locale, got {lang}"
        );
    }

    #[test]
    fn a_final_newline_is_stripped_like_ejeca_does() {
        assert_eq!(strip_final_newline("/w/repo\n".to_owned()), "/w/repo");
        assert_eq!(strip_final_newline("/w/repo\r\n".to_owned()), "/w/repo");
        assert_eq!(strip_final_newline("a\n\n".to_owned()), "a\n");
        assert_eq!(strip_final_newline(String::new()), "");
    }
}
