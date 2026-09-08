use std::process::Command;
use std::time::Duration;

use cosmic::iced::{window::Id, Limits, Subscription};
use cosmic::prelude::*;
use cosmic::widget;

#[derive(Default)]
pub struct AppModel {
    core: cosmic::Core,
    popup: Option<Id>,
    status: String,
}

#[derive(Debug, Clone)]
pub enum Message {
    Refresh,
    TogglePopup,
    PopupClosed(Id),
}

impl cosmic::Application for AppModel {
    type Executor = cosmic::executor::Default;
    type Flags = ();
    type Message = Message;

    const APP_ID: &'static str = "com.github.astahmer.tokitoki";

    fn core(&self) -> &cosmic::Core {
        &self.core
    }

    fn core_mut(&mut self) -> &mut cosmic::Core {
        &mut self.core
    }

    fn init(
        core: cosmic::Core,
        _flags: Self::Flags,
    ) -> (Self, Task<cosmic::Action<Self::Message>>) {
        (
            Self {
                core,
                status: read_status(),
                ..Default::default()
            },
            Task::none(),
        )
    }

    fn on_close_requested(&self, id: Id) -> Option<Message> {
        Some(Message::PopupClosed(id))
    }

    fn view(&self) -> Element<'_, Self::Message> {
        self.core
            .applet
            .icon_button("display-symbolic")
            .on_press(Message::TogglePopup)
            .into()
    }

    fn view_window(&self, _id: Id) -> Element<'_, Self::Message> {
        let content = widget::column()
            .push(widget::text("Tokitoki Usage"))
            .push(widget::text(self.status.clone()))
            .spacing(8)
            .padding(12);
        self.core.applet.popup_container(content).into()
    }

    fn subscription(&self) -> Subscription<Self::Message> {
        cosmic::iced::time::every(Duration::from_secs(30)).map(|_| Message::Refresh)
    }

    fn update(&mut self, message: Self::Message) -> Task<cosmic::Action<Self::Message>> {
        match message {
            Message::Refresh => self.status = read_status(),
            Message::TogglePopup => {
                return if let Some(popup) = self.popup.take() {
                    cosmic::iced::platform_specific::shell::wayland::commands::popup::destroy_popup(
                        popup,
                    )
                } else {
                    let new_id = Id::unique();
                    self.popup = Some(new_id);
                    let mut settings = self.core.applet.get_popup_settings(
                        self.core.main_window_id().unwrap(),
                        new_id,
                        None,
                        None,
                        None,
                    );
                    settings.positioner.size_limits = Limits::NONE
                        .max_width(360.0)
                        .min_width(260.0)
                        .min_height(100.0)
                        .max_height(240.0);
                    cosmic::iced::platform_specific::shell::wayland::commands::popup::get_popup(
                        settings,
                    )
                };
            }
            Message::PopupClosed(id) => {
                if self.popup == Some(id) {
                    self.popup = None;
                }
            }
        }
        Task::none()
    }

    fn style(&self) -> Option<cosmic::iced::theme::Style> {
        Some(cosmic::applet::style())
    }
}

fn read_status() -> String {
    let output = match Command::new("tokitoki")
        .args(["widget-payload", "--cached", "--json"])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return "tokitoki unavailable".to_string(),
    };

    let payload: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(payload) => payload,
        Err(_) => return "invalid tokitoki payload".to_string(),
    };
    let stats = &payload["stats"];
    let cost = stats["costUsd"].as_f64().unwrap_or(0.0);
    let tokens = stats["tokens"].as_u64().unwrap_or(0);
    let requests = stats["requests"].as_u64().unwrap_or(0);
    let sessions = stats["sessions"].as_u64().unwrap_or(0);
    format!("${cost:.2} · {tokens} tokens · {requests} requests · {sessions} sessions")
}
