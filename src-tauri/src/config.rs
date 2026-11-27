use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;

use crate::error::{Error, Result};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscordPreferences {
    pub enabled: bool,
    pub share_local: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Interface + metadata language (hl).
    pub language: Option<String>,
    /// Accent palette id; the frontend owns the colours and falls back to its default.
    pub palette: Option<String>,
    pub discord: DiscordPreferences,
}

pub struct ConfigStore {
    path: PathBuf,
    data: RwLock<Settings>,
}

impl ConfigStore {
    pub fn load(path: PathBuf) -> Self {
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self {
            path,
            data: RwLock::new(data),
        }
    }

    pub fn get(&self) -> Settings {
        self.data
            .read()
            .map(|data| data.clone())
            .unwrap_or_default()
    }

    pub fn save(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings> {
        let mut current = self
            .data
            .write()
            .map_err(|_| Error::io("Настройки недоступны"))?;
        let mut settings = current.clone();
        change(&mut settings);
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(&settings)
            .map_err(|error| Error::io(error.to_string()))?;
        std::fs::write(&self.path, text)?;
        *current = settings.clone();
        Ok(settings)
    }

    pub fn language(&self) -> String {
        self.get().language.unwrap_or_else(|| "ru".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_settings_do_not_enable_discord_sharing() {
        let settings: Settings =
            serde_json::from_str(r#"{"language":"ru","palette":"ice"}"#).unwrap();
        assert_eq!(settings.discord, DiscordPreferences::default());
    }

    #[test]
    fn an_old_discord_id_is_ignored_without_changing_privacy_preferences() {
        let settings: Settings = serde_json::from_str(
            r#"{"discord":{"enabled":true,"shareLocal":false,"applicationId":"123456789012345678"}}"#,
        ).unwrap();
        assert_eq!(
            serde_json::to_value(settings.discord).unwrap(),
            serde_json::json!({"enabled": true, "shareLocal": false}),
        );
    }

    #[test]
    fn appearance_saves_keep_the_discord_opt_in() {
        let path =
            std::env::temp_dir().join(format!("burn-discord-config-{}.json", std::process::id()));
        let config = ConfigStore::load(path.clone());
        let discord = DiscordPreferences {
            enabled: true,
            share_local: false,
        };
        config
            .save(|settings| settings.discord = discord.clone())
            .unwrap();
        config
            .save(|settings| settings.palette = Some("ice".into()))
            .unwrap();
        let saved = ConfigStore::load(path.clone()).get();
        std::fs::remove_file(path).unwrap();
        assert_eq!(saved.discord, discord);
        assert_eq!(saved.palette.as_deref(), Some("ice"));
    }
}
