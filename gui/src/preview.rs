//! Plain-text preview formatting and fail-closed approval predicates.
use serde_json::Value;

/// Only canonical UUID syntax can be passed to the backend as an operation ID.
pub fn valid_operation_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

/// Split without losing a Unicode scalar, including trailing blank lines.
pub fn chunks(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut rows = Vec::new();
    for line in text.split('\n') {
        let mut start = 0;
        let mut count = 0;
        for (offset, _) in line.char_indices() {
            if count == width {
                rows.push(line[start..offset].to_owned());
                start = offset;
                count = 0;
            }
            count += 1;
        }
        rows.push(line[start..].to_owned());
    }
    rows
}

/// Render every byte semantically as JSON text, never HTML/Markdown or executable links.
/// Invisible direction controls are escaped so note text cannot spoof the approval chrome.
pub fn preview_rows(preview: &Value) -> Result<Vec<String>, serde_json::Error> {
    let json = serde_json::to_string_pretty(preview)?;
    let mut visible = String::with_capacity(json.len());
    for ch in json.chars() {
        if matches!(ch, '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
        {
            use std::fmt::Write;
            // Writing to String cannot fail; handle the trait result without a panic.
            let _ = write!(visible, "\\u{:04x}", ch as u32);
        } else {
            visible.push(ch);
        }
    }
    Ok(chunks(&visible, 48))
}

/// Identity comes from the same backend account context as the decrypted journal, not note text.
/// An explicit account choice must match; only a uniquely resolved backend identity may fill none.
pub fn bound_preview_account(preview: &Value, expected: Option<&str>) -> Option<String> {
    // Binding is local to the journal; it does not assert a live cloud session.
    if preview["accountBound"].as_bool() != Some(true) {
        return None;
    }
    let email = preview["email"].as_str()?;
    if email.is_empty() || email.len() > 320 || !email.contains('@')
        || email.chars().any(|ch| ch.is_whitespace() || ch.is_control()
            || matches!(ch, '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}'))
        || expected.is_some_and(|expected| expected != email)
    { return None; }
    Some(email.to_owned())
}

/// Read-only approval chrome must never present an inherited/unbound email as the actual account.
pub fn approval_account_label(preview: Option<&Value>, pinned: Option<&str>) -> String {
    pinned
        .and_then(|pinned| preview.and_then(|preview| bound_preview_account(preview, Some(pinned))))
        .map(|email| format!("Approval account (pinned): {email}"))
        .unwrap_or_else(|| "Approval account unavailable. Approval is disabled.".into())
}

/// Approval requires the exact operation and pinned backend identity, plus fresh human consent.
pub fn can_approve(
    preview: Option<&Value>,
    operation_id: &str,
    consent: bool,
    busy: bool,
    pinned: Option<&str>,
) -> bool {
    consent
        && !busy
        && valid_operation_id(operation_id)
        && preview.is_some_and(|p| {
            p["operationId"].as_str() == Some(operation_id)
                && p["status"].as_str() == Some("prepared")
                && p.get("preview").is_some()
                && pinned.is_some_and(|pinned| bound_preview_account(p, Some(pinned)).is_some())
        })
}

/// A successful process or an arbitrary truthy result is not durable approval evidence.
pub fn approval_confirmed(result: &Value, operation_id: &str) -> bool {
    result["approved"] == true && result["operationId"].as_str() == Some(operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const ID: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn unicode_chunks_preserve_all_text_including_long_lines() {
        let line = "aé🧑‍💻漢字".repeat(20_000);
        let rows = chunks(&line, 48);
        assert_eq!(rows.concat(), line);
        assert!(rows.iter().all(|row| row.chars().count() <= 48));
        assert_eq!(chunks("a\n\n", 48), vec!["a", "", ""]);
    }

    #[test]
    fn untrusted_content_remains_complete_plain_json() {
        let value = json!({"before":"<script>evil()</script>\n\u{202e}https://example.invalid", "after":"🦀".repeat(500)});
        let rows = preview_rows(&value).expect("synthetic preview serializes");
        assert!(rows.iter().all(|r| r.chars().count() <= 48));
        let joined = rows.concat();
        assert!(joined.contains("\\u202e"));
        assert!(!joined.contains('\u{202e}'));
        assert_eq!(joined.matches('🦀').count(), 500);
    }

    #[test]
    fn approval_without_backend_identity_is_disabled() {
        let preview =
            json!({"operationId":ID,"status":"prepared","preview":{"before":"x","after":"y"}});
        assert!(
            !can_approve(Some(&preview), ID, true, false, Some("a@example.invalid")),
            "an inherited email is not proof of the loaded journal's account"
        );
    }

    #[test]
    fn approval_fails_closed() {
        let preview = json!({"operationId":ID,"status":"prepared","preview":{"before":"x","after":"y"},"email":"a@example.invalid","accountBound":true});
        let pinned = Some("a@example.invalid");
        assert!(can_approve(Some(&preview), ID, true, false, pinned));
        assert!(!can_approve(Some(&preview), ID, false, false, pinned));
        assert!(!can_approve(Some(&preview), ID, true, true, pinned));
        assert!(!can_approve(None, ID, true, false, pinned));
        assert!(!can_approve(Some(&preview), "other", true, false, pinned));
        assert!(!can_approve(Some(&preview), ID, true, false, None));
        assert!(!can_approve(
            Some(&preview),
            ID,
            true,
            false,
            Some("b@example.invalid")
        ));
        for status in ["rejected", "committed", "uncertain", "attempted"] {
            let mut changed = preview.clone();
            changed["status"] = json!(status);
            assert!(!can_approve(Some(&changed), ID, true, false, pinned));
        }
        assert!(!approval_confirmed(
            &json!({"approved":true,"operationId":"other"}),
            ID
        ));
        assert!(!approval_confirmed(
            &json!({"approved":"true","operationId":ID}),
            ID
        ));
        assert!(approval_confirmed(
            &json!({"approved":true,"operationId":ID}),
            ID
        ));
    }

    #[test]
    fn approval_identity_is_locally_bound_and_never_switches_a_pinned_account() {
        let preview = json!({"email":"a@example.invalid","accountBound":true});
        assert_eq!(
            bound_preview_account(&preview, None).as_deref(),
            Some("a@example.invalid")
        );
        assert_eq!(
            bound_preview_account(&preview, Some("a@example.invalid")).as_deref(),
            Some("a@example.invalid")
        );
        assert!(bound_preview_account(&preview, Some("b@example.invalid")).is_none());
        for invalid in [
            json!({"email":"a@example.invalid"}),
            json!({"email":"a@example.invalid","accountBound":false}),
            json!({"email":"a@example.invalid","accountBound":"true"}),
            json!({"preview":{"email":"a@example.invalid","accountBound":true}}),
            json!({"accountBound":true}),
            json!({"email":"","accountBound":true}),
            json!({"email":"a@example.invalid\n","accountBound":true}),
            json!({"email":"a@\u{202e}example.invalid","accountBound":true}),
            json!({"email":"a@example.invalid","identityVerified":true}),
        ] {
            assert!(bound_preview_account(&invalid, None).is_none());
        }
    }

    #[test]
    fn approval_label_shows_only_the_exact_confirmed_pinned_identity() {
        let preview = json!({"email":"a@example.invalid","accountBound":true});
        assert_eq!(
            approval_account_label(Some(&preview), Some("a@example.invalid")),
            "Approval account (pinned): a@example.invalid"
        );
        for label in [
            approval_account_label(None, Some("a@example.invalid")),
            approval_account_label(Some(&preview), None),
            approval_account_label(Some(&preview), Some("b@example.invalid")),
        ] {
            assert!(label.contains("unavailable"));
            assert!(!label.contains("@"));
        }
    }

    #[test]
    fn uuid_validation_rejects_arguments_and_unicode() {
        assert!(valid_operation_id(ID));
        for id in [
            "",
            "--approve",
            "../notes",
            "00000000-0000-4000-8000-00000000000é",
            "00000000-0000-4000-8000-00000000000g",
        ] {
            assert!(!valid_operation_id(id));
        }
    }
}
