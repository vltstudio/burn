use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;

use crate::error::{Error, Result};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Interface + metadata language (hl).
    pub language: Option<String>,
    /// Accent palette id; the frontend owns the colours and falls back to its default.
    pub palette: Option<String>,
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
        self.data.read().map(|data| data.clone()).unwrap_or_default()
    }

    pub fn save(&self, settings: Settings) -> Result<Settings> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(&settings)
            .map_err(|error| Error::io(error.to_string()))?;
        std::fs::write(&self.path, text)?;
        if let Ok(mut data) = self.data.write() {
            *data = settings.clone();
        }
        Ok(settings)
    }

    pub fn language(&self) -> String {
        self.get().language.unwrap_or_else(|| "ru".into())
    }
}
