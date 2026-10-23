//! Portable native Standard Notes connection and per-operation approval frontend.
mod account;
mod layout;
pub mod preview;
pub mod protocol;
mod settings;
pub mod ui;

/// Parse only the supported portable launch modes. No note or credential arguments exist.
pub fn approval_argument(args: &[String]) -> Result<Option<String>, &'static str> {
    match args {
        [] => Ok(None),
        [flag, id] if flag == "--approve" && preview::valid_operation_id(id) => {
            Ok(Some(id.clone()))
        }
        _ => Err("Expected no arguments, or --approve followed by an operation UUID"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_modes_accept_only_uuid_and_never_credentials() {
        assert_eq!(approval_argument(&[]), Ok(None));
        assert!(
            approval_argument(&[
                "--approve".into(),
                "00000000-0000-4000-8000-000000000001".into()
            ])
            .expect("canonical operation UUID is valid")
            .is_some()
        );
        for args in [
            vec!["--password".into(), "synthetic".into()],
            vec!["--approve".into()],
            vec!["--approve".into(), "../file".into()],
        ] {
            assert!(approval_argument(&args).is_err());
        }
    }
}
