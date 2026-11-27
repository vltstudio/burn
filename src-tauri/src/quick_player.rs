use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub(crate) struct Placement {
    edge: &'static str,
    arrow: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Action {
    Status,
    Expand,
    Compact,
    Hide,
    OpenMain,
}

#[tauri::command]
pub(crate) async fn quick_window(
    window: tauri::WebviewWindow,
    action: Action,
) -> Result<Option<Placement>, String> {
    if window.label() != "quick-player" {
        return Err("Quick player window only".into());
    }
    #[cfg(windows)]
    return windows::act(&window, action).map_err(|error| error.to_string());
    #[cfg(not(windows))]
    {
        let _ = action;
        Ok(None)
    }
}

#[cfg(windows)]
pub(crate) use windows::setup;

#[cfg(windows)]
mod windows {
    use super::{Action, Placement};
    use std::sync::Mutex;
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::{
        App, Emitter, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, Rect, WebviewUrl,
        WebviewWindow, WebviewWindowBuilder, WindowEvent,
    };

    const LABEL: &str = "quick-player";
    const VISIBILITY: &str = "vlt-quick-visibility";
    const WIDTH: f64 = 382.0;
    const COMPACT: f64 = 248.0;
    const EXPANDED: f64 = 498.0;

    #[derive(Clone, Copy)]
    struct Anchor {
        rect: Rect,
        cursor: PhysicalPosition<f64>,
    }

    #[derive(Default)]
    struct QuickState {
        anchor: Mutex<Option<Anchor>>,
    }

    fn reposition(window: &WebviewWindow, anchor: Anchor, height: f64) -> tauri::Result<Placement> {
        let monitor = window
            .monitor_from_point(anchor.cursor.x, anchor.cursor.y)?
            .or(window.primary_monitor()?)
            .ok_or(tauri::Error::WindowNotFound)?;
        let (position, size, placement) = popup_geometry(
            &PhysicalRect {
                position: *monitor.position(),
                size: *monitor.size(),
            },
            monitor.work_area(),
            monitor.scale_factor(),
            anchor,
            height,
        );
        window.set_position(position)?;
        window.set_size(size)?;
        Ok(placement)
    }

    fn popup_geometry(
        screen: &PhysicalRect<i32, u32>,
        work: &PhysicalRect<i32, u32>,
        scale: f64,
        anchor: Anchor,
        height: f64,
    ) -> (PhysicalPosition<i32>, PhysicalSize<u32>, Placement) {
        let left = work.position.x as f64;
        let top = work.position.y as f64;
        let right = left + work.size.width as f64;
        let bottom = top + work.size.height as f64;
        let p = anchor.rect.position.to_physical::<f64>(scale);
        let s = anchor.rect.size.to_physical::<f64>(scale);
        let center = if s.width > 0.0 && s.height > 0.0 {
            PhysicalPosition::new(p.x + s.width / 2.0, p.y + s.height / 2.0)
        } else {
            anchor.cursor
        };
        let edges = [
            ("bottom", screen.position.y as f64 + screen.size.height as f64 - bottom),
            ("top", top - screen.position.y as f64),
            ("right", screen.position.x as f64 + screen.size.width as f64 - right),
            ("left", left - screen.position.x as f64),
        ];
        let edge = edges.into_iter()
            .max_by(|(_, a), (_, b)| a.total_cmp(b))
            .filter(|(_, gap)| *gap > 1.0)
            .map_or_else(
                || if center.y >= (top + bottom) / 2.0 { "bottom" } else { "top" },
                |(edge, _)| edge,
            );
        let width = (WIDTH * scale).round().min(right - left);
        let height = (height * scale).round().min(bottom - top);
        let x = match edge {
            "left" => left,
            "right" => right - width,
            _ => (center.x - width / 2.0).clamp(left, right - width),
        };
        let y = match edge {
            "top" => top,
            "bottom" => bottom - height,
            _ => (center.y - height / 2.0).clamp(top, bottom - height),
        };
        let (offset, length) = match edge {
            "left" | "right" => (center.y - y, height),
            _ => (center.x - x, width),
        };
        let arrow = (100.0 * offset / length.max(1.0)).clamp(9.0, 91.0);
        (
            PhysicalPosition::new(x.round() as i32, y.round() as i32),
            PhysicalSize::new(width as u32, height as u32),
            Placement { edge, arrow },
        )
    }

    fn notify(window: &WebviewWindow, placement: Option<&Placement>) {
        let _ = window.emit_to("main", VISIBILITY, placement.is_some());
        let _ = window.emit_to(LABEL, VISIBILITY, placement);
    }

    fn hide(window: &WebviewWindow) -> tauri::Result<()> {
        let state = window.state::<QuickState>();
        if state.anchor.lock().unwrap().take().is_some() {
            window.hide()?;
            notify(window, None);
        }
        Ok(())
    }

    pub(super) fn act(window: &WebviewWindow, action: Action) -> tauri::Result<Option<Placement>> {
        match action {
            Action::Hide => hide(window)?,
            Action::OpenMain => {
                hide(window)?;
                if let Some(main) = window.get_webview_window("main") {
                    main.show()?;
                    main.unminimize()?;
                    main.set_focus()?;
                }
            }
            Action::Status | Action::Expand | Action::Compact => {
                let state = window.state::<QuickState>();
                let anchor = *state.anchor.lock().unwrap();
                let height = if matches!(action, Action::Expand) { EXPANDED } else { COMPACT };
                return anchor.map(|anchor| reposition(window, anchor, height)).transpose();
            }
        }
        Ok(None)
    }

    pub(crate) fn setup(app: &mut App) -> tauri::Result<()> {
        let icon = app.default_window_icon().cloned().ok_or_else(|| tauri::Error::WindowNotFound)?;
        let main = app.get_webview_window("main").ok_or_else(|| tauri::Error::WindowNotFound)?;
        let quick = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
            .title("BURN · Быстрый плеер")
            .inner_size(WIDTH, COMPACT)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible(false)
            .focused(false)
            .build()?;
        app.manage(QuickState::default());

        let tray = TrayIconBuilder::with_id("vlt-quick")
            .icon(icon)
            .tooltip("BURN — быстрый плеер")
            .on_tray_icon_event(|tray, event| {
                let TrayIconEvent::Click {
                    position,
                    rect,
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event else { return };
                let Some(window) = tray.app_handle().get_webview_window(LABEL) else { return };
                let state = window.state::<QuickState>();
                if state.anchor.lock().unwrap().is_some() {
                    let _ = hide(&window);
                    return;
                }
                let anchor = Anchor { rect, cursor: position };
                if let Ok(placement) = reposition(&window, anchor, COMPACT) {
                    *state.anchor.lock().unwrap() = Some(anchor);
                    if window.show().and_then(|_| window.set_focus()).is_ok() {
                        notify(&window, Some(&placement));
                    } else {
                        let _ = hide(&window);
                    }
                }
            })
            .build(app);
        if let Err(error) = tray {
            let _ = quick.destroy();
            return Err(error);
        }

        let quick_for_event = quick.clone();
        quick.on_window_event(move |event| match event {
            WindowEvent::Focused(false) => {
                let window = quick_for_event.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(140)).await;
                    if matches!(window.is_focused(), Ok(false)) {
                        let _ = hide(&window);
                    }
                });
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = hide(&quick_for_event);
            }
            _ => {}
        });
        main.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                let _ = quick.destroy();
            }
        });
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn physical(x: i32, y: i32, width: u32, height: u32) -> PhysicalRect<i32, u32> {
            PhysicalRect {
                position: PhysicalPosition::new(x, y),
                size: PhysicalSize::new(width, height),
            }
        }

        fn icon(x: i32, y: i32) -> Anchor {
            Anchor {
                rect: Rect {
                    position: PhysicalPosition::new(x, y).into(),
                    size: PhysicalSize::new(24, 24).into(),
                },
                cursor: PhysicalPosition::new((x + 12) as f64, (y + 12) as f64),
            }
        }

        #[test]
        fn bottom_popup_stays_at_taskbar_for_visible_and_overflow_icons() {
            let screen = physical(0, 0, 1920, 1080);
            let work = physical(0, 0, 1920, 1032);
            for anchor in [icon(1680, 1044), icon(1600, 844)] {
                for height in [COMPACT, EXPANDED] {
                    let (pos, size, placement) = popup_geometry(&screen, &work, 1.0, anchor, height);
                    assert_eq!(placement.edge, "bottom");
                    assert_eq!(pos.y + size.height as i32, 1032);
                    assert_eq!(pos.x as f64 + size.width as f64 * placement.arrow / 100.0, anchor.cursor.x);
                }
            }
        }

        #[test]
        fn side_taskbar_uses_monitor_work_edge_and_scaled_popup_size() {
            let screen = physical(-1920, 0, 1920, 1080);
            let work = physical(-1856, 0, 1856, 1080);
            let (pos, size, placement) = popup_geometry(&screen, &work, 1.5, icon(-1880, 550), COMPACT);
            assert_eq!(placement.edge, "left");
            assert_eq!(pos.x, -1856);
            assert_eq!(size.width, 573);
            assert_eq!(size.height, 372);
        }
    }
}
