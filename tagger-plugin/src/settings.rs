//! The plugin's settings, from its form in Navidrome.

use extism_pdk::config;

pub struct Settings {
    /// The Aonsoku-BS web app, e.g. https://mus.example.com.
    pub sync_server_url: String,
    pub secret: String,
    /// The admin the plugin rescans edited folders as.
    pub scan_user: String,
    /// Navidrome itself, from inside its container.
    pub navidrome_url: String,
}

impl Settings {
    pub fn load() -> Result<Self, String> {
        let get = |key: &str| config::get(key).ok().flatten().map(|v| v.trim().to_string());
        let required = |key: &str| {
            get(key)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| format!("The setting \"{key}\" is not set"))
        };
        Ok(Self {
            sync_server_url: required("syncServerUrl")?,
            secret: required("secret")?,
            scan_user: required("scanUser")?,
            navidrome_url: get("navidromeUrl")
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "http://127.0.0.1:4533".to_string()),
        })
    }

    /// The WebSocket address the plugin connects to on the Aonsoku-BS server.
    pub fn link_url(&self) -> Result<String, String> {
        link_url(&self.sync_server_url)
    }
}

/// `https://host/path` → `wss://host/path/jam-sync/tagger/plugin`.
pub fn link_url(server: &str) -> Result<String, String> {
    let server = server.trim().trim_end_matches('/');
    let rest = if let Some(rest) = server.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = server.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if server.starts_with("wss://") || server.starts_with("ws://") {
        server.to_string()
    } else {
        return Err(format!("\"{server}\" is not an http(s) address"));
    };
    Ok(format!("{rest}/jam-sync/tagger/plugin"))
}

#[cfg(test)]
mod tests {
    use super::link_url;

    #[test]
    fn builds_the_websocket_address() {
        assert_eq!(
            link_url("https://mus.example.com/").unwrap(),
            "wss://mus.example.com/jam-sync/tagger/plugin"
        );
        assert_eq!(
            link_url("http://10.0.0.5:8097").unwrap(),
            "ws://10.0.0.5:8097/jam-sync/tagger/plugin"
        );
        assert!(link_url("mus.example.com").is_err());
    }
}
