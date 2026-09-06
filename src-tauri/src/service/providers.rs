//! Launcher provider templates and the public DSH settings mapping.
//! Secrets are separate from metadata and must never be returned by list APIs.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTemplate {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub models: Vec<ProviderModel>,
    #[serde(default)]
    pub default_for_new: bool,
}

impl ProviderTemplate {
    /// Validate before persisting or constructing any DSH mutation.
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 80
            || !self.id.as_bytes()[0].is_ascii_lowercase()
            || !self
                .id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || self.id.ends_with('-')
            || self.id.contains("--")
        {
            return Err("PROVIDER_ID_INVALID".into());
        }
        if self.name.trim().is_empty()
            || self.name.len() > 160
            || self.name.chars().any(char::is_control)
        {
            return Err("PROVIDER_NAME_INVALID".into());
        }
        let url = reqwest::Url::parse(&self.base_url).map_err(|_| "PROVIDER_URL_INVALID")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("PROVIDER_URL_INVALID".into());
        }
        if self.protocol.is_empty() || self.protocol.chars().any(char::is_control) {
            return Err("PROVIDER_PROTOCOL_INVALID".into());
        }
        let ids: Vec<&str> = if self.models.is_empty() { vec![&self.model_id] } else { self.models.iter().map(|m| m.id.as_str()).collect() };
        let mut unique = std::collections::HashSet::new();
        if ids.len() > 2000 || ids.iter().any(|id| id.trim().is_empty() || *id != id.trim() || id.len() > 512 || id.chars().any(char::is_control) || !unique.insert(*id))
            || self.models.iter().any(|m| m.context_window == Some(0) || m.max_tokens == Some(0) || m.name.as_ref().is_some_and(|n| n.len() > 512 || n.chars().any(char::is_control))) {
            return Err("PROVIDER_MODEL_INVALID".into());
        }
        Ok(())
    }

    pub fn credential_ref(&self) -> String {
        format!(
            "DSH_LAUNCHER_{}_API_KEY",
            self.id.replace('-', "_").to_ascii_uppercase()
        )
    }

    /// Only use protocols discovered from the selected runtime's schema.
    pub fn profile(&self, supported_protocols: &[String]) -> Result<Value, String> {
        self.validate()?;
        if !supported_protocols.contains(&self.protocol) {
            return Err("PROVIDER_PROTOCOL_UNSUPPORTED".into());
        }
        Ok(json!({
            "displayName": self.name,
            "baseURL": self.base_url,
            "api": self.protocol,
            "apiKeyEnv": self.credential_ref(),
            "models": if self.models.is_empty() { json!([{ "id": self.model_id }]) } else { json!(self.models) },
        }))
    }
}

/// Construct a non-destructive plan. Existing IDs require an explicit overwrite.
/// Keep advanced provider fields when updating the four template-owned fields.
pub fn plan_import(
    providers: &Value,
    template: &ProviderTemplate,
    supported_protocols: &[String],
    overwrite: bool,
) -> Result<Value, String> {
    let incoming = template.profile(supported_protocols)?;
    let existing = providers.as_object().ok_or("PROVIDER_SETTINGS_INVALID")?;
    let mut next = existing.clone();
    if let Some(value) = existing.get(&template.id) {
        if !overwrite {
            return Err("PROVIDER_ID_CONFLICT".into());
        }
        let mut merged = value
            .as_object()
            .ok_or("PROVIDER_SETTINGS_INVALID")?
            .clone();
        for (key, value) in incoming.as_object().unwrap() {
            merged.insert(key.clone(), value.clone());
        }
        next.insert(template.id.clone(), Value::Object(merged));
    } else {
        next.insert(template.id.clone(), incoming);
    }
    Ok(Value::Object(next))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn template() -> ProviderTemplate {
        ProviderTemplate {
            id: "my-gateway".into(),
            name: "Gateway".into(),
            base_url: "https://example.com/v1".into(),
            protocol: "openai-completions".into(),
            model_id: "gateway-model".into(),
            models: vec![],
            default_for_new: true,
        }
    }
    #[test]
    fn supports_multiple_models_and_legacy_templates() {
        let mut item = template();
        item.model_id.clear();
        assert!(item.validate().is_err());
        item.models = serde_json::from_value(json!([
            {"id":"first", "contextWindow":64000}, {"id":"second", "name":"Second"}
        ])).unwrap();
        assert!(item.validate().is_ok());
        let restored: ProviderTemplate = serde_json::from_value(serde_json::to_value(&item).unwrap()).unwrap();
        assert_eq!(restored.models[0].context_window, Some(64000));
        item.models.push(item.models[0].clone());
        assert_eq!(item.validate().unwrap_err(), "PROVIDER_MODEL_INVALID");
        let mut legacy = serde_json::to_value(template()).unwrap();
        legacy.as_object_mut().unwrap().remove("models");
        assert!(serde_json::from_value::<ProviderTemplate>(legacy).unwrap().validate().is_ok());
    }
    #[test]
    fn import_preserves_other_providers_and_advanced_fields() {
        let existing = json!({"other": {"models": ["keep"]}, "my-gateway": {"models": [{"id":"custom"}], "headers":{"x-custom":"keep"}}});
        let protocols = vec!["openai-completions".into()];
        assert_eq!(
            plan_import(&existing, &template(), &protocols, false).unwrap_err(),
            "PROVIDER_ID_CONFLICT"
        );
        let updated = plan_import(&existing, &template(), &protocols, true).unwrap();
        assert_eq!(updated["other"], existing["other"]);
        assert_eq!(
            updated["my-gateway"]["models"],
            json!([{"id":"gateway-model"}])
        );
        assert_eq!(
            updated["my-gateway"]["headers"],
            existing["my-gateway"]["headers"]
        );
        assert_eq!(
            updated["my-gateway"]["apiKeyEnv"],
            "DSH_LAUNCHER_MY_GATEWAY_API_KEY"
        );
    }
    #[test]
    fn rejects_secret_urls_unsafe_ids_and_unsupported_protocols() {
        for url in [
            "file:///tmp/key",
            "https://key@example.com",
            "https://example.com?key=secret",
            "https://example.com#secret",
        ] {
            let mut item = template();
            item.base_url = url.into();
            assert!(item.validate().is_err());
        }
        for id in [
            "",
            "../other",
            "MyProvider",
            "my_provider",
            "my--provider",
            "my-",
        ] {
            let mut item = template();
            item.id = id.into();
            assert!(item.validate().is_err());
        }
        assert!(template().profile(&[]).is_err());
    }
}
