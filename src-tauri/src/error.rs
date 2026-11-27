use serde::ser::{Serialize, SerializeStruct, Serializer};

#[derive(Debug)]
pub enum Error {
    /// No credentials, or the stored token was rejected: the UI must offer sign-in.
    Auth(String),
    /// Something went wrong talking to YouTube Music.
    Api(String),
    /// Local problem, e.g. the settings file.
    Io(String),
    /// The audio stream could not be resolved.
    Player(String),
}

impl Error {
    pub fn api(message: impl Into<String>) -> Self {
        Error::Api(message.into())
    }

    pub fn io(message: impl Into<String>) -> Self {
        Error::Io(message.into())
    }

    pub fn player(message: impl Into<String>) -> Self {
        Error::Player(message.into())
    }

    fn needs_player(&self) -> bool {
        matches!(self, Error::Player(_))
    }

    fn needs_auth(&self) -> bool {
        matches!(self, Error::Auth(_))
    }

    fn message(&self) -> &str {
        match self {
            Error::Auth(m) | Error::Api(m) | Error::Io(m) | Error::Player(m) => m,
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for Error {}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            Error::Api("YouTube Music не ответил вовремя — проверьте интернет или VPN".into())
        } else if e.is_connect() {
            Error::Api(format!(
                "Нет связи с music.youtube.com — проверьте интернет или VPN ({})",
                transport_detail(&e)
            ))
        } else {
            Error::Api(format!(
                "Запрос к YouTube Music не удался ({})",
                transport_detail(&e)
            ))
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Api(format!("Неожиданный ответ YouTube Music: {e}"))
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e.to_string())
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("Error", 3)?;
        s.serialize_field("message", self.message())?;
        s.serialize_field("needsAuth", &self.needs_auth())?;
        s.serialize_field("needsPlayer", &self.needs_player())?;
        s.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Short, secret-free description of a transport failure for the user.
fn transport_detail(error: &reqwest::Error) -> String {
    let text = error.to_string();
    let mut message = text
        .lines()
        .next()
        .unwrap_or("network error")
        .trim()
        .to_string();
    if message.chars().count() > 140 {
        message = message.chars().take(140).collect();
    }
    message
}
