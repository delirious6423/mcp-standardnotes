//! Account selection is independent of inherited process environment after a GUI choice.
use serde_json::Value;

#[derive(Default)]
pub(crate) struct AccountState {
    pub email: Option<String>,
    counts: Option<(u64, u64)>,
}

impl AccountState {
    /// Invalidate any previous successful check before starting a new request.
    pub fn begin(&mut self, email: Option<&str>) {
        if let Some(email) = email.filter(|email| !email.trim().is_empty()) {
            self.email = Some(email.trim().to_owned());
        }
        self.counts = None;
    }

    pub fn saved_status(&mut self, result: &Value) -> bool {
        self.counts = None;
        if result["savedSession"] != true {
            return false;
        }
        if let Some(email) = result["email"]
            .as_str()
            .filter(|email| !email.trim().is_empty())
        {
            self.email = Some(email.to_owned());
            true
        } else {
            false
        }
    }

    pub fn connected(&mut self, result: &Value) -> bool {
        self.counts = None;
        if let (Some(true), Some(email), Some(notes), Some(tags)) = (
            result["connected"].as_bool(),
            result["email"]
                .as_str()
                .filter(|email| !email.trim().is_empty()),
            result["notes"].as_u64(),
            result["tags"].as_u64(),
        ) {
            self.email = Some(email.to_owned());
            self.counts = Some((notes, tags));
            true
        } else {
            false
        }
    }

    pub fn label(&self) -> String {
        match (&self.email, self.counts) {
            (Some(email), Some((notes, tags))) => {
                format!("Connected as {email}. {notes} notes, {tags} tags.")
            }
            (Some(email), None) => {
                format!("Account {email}: connection not verified. Use Check connection.")
            }
            (None, _) => "Enter saved account email then Check connection, or sign in.".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selecting_b_cannot_reuse_a_or_keep_stale_connected_counts() {
        let mut account = AccountState::default();
        assert!(
            account.connected(
                &json!({"connected":true,"email":"a@example.invalid","notes":12,"tags":2})
            )
        );
        assert!(account.label().starts_with("Connected as a@"));
        account.begin(Some(" b@example.invalid "));
        assert_eq!(account.email.as_deref(), Some("b@example.invalid"));
        assert!(!account.label().starts_with("Connected"));
        assert!(!account.label().contains("12 notes"));
        // A failed check/login leaves B selected and unverified, not environment account A.
        assert!(!account.connected(&json!({"connected":false})));
        assert_eq!(account.email.as_deref(), Some("b@example.invalid"));
        assert!(
            account.connected(
                &json!({"connected":true,"email":"b@example.invalid","notes":7,"tags":1})
            )
        );
        assert_eq!(account.email.as_deref(), Some("b@example.invalid"));
        account.begin(None);
        assert!(!account.label().starts_with("Connected"));
    }

    #[test]
    fn no_unique_saved_account_never_claims_verified_connection() {
        let mut account = AccountState::default();
        assert!(!account.saved_status(&json!({"savedSession":false})));
        assert!(account.label().contains("Enter saved account email"));
        assert!(account.saved_status(&json!({"savedSession":true,"email":"a@example.invalid"})));
        assert!(!account.label().starts_with("Connected"));
    }
}
