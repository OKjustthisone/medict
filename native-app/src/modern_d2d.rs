use windows::{
    core::{w, Result},
    Win32::{
        Foundation::HWND,
        Graphics::{
            Direct2D::{
                Common::{
                    D2D1_ALPHA_MODE_IGNORE, D2D1_COLOR_F, D2D1_PIXEL_FORMAT, D2D_RECT_F, D2D_SIZE_U,
                },
                D2D1CreateFactory, ID2D1Factory, ID2D1HwndRenderTarget,
                D2D1_ANTIALIAS_MODE_PER_PRIMITIVE, D2D1_DRAW_TEXT_OPTIONS_NONE, D2D1_ELLIPSE,
                D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_FEATURE_LEVEL_DEFAULT,
                D2D1_HWND_RENDER_TARGET_PROPERTIES, D2D1_PRESENT_OPTIONS_NONE,
                D2D1_RENDER_TARGET_PROPERTIES, D2D1_RENDER_TARGET_TYPE_DEFAULT,
                D2D1_RENDER_TARGET_USAGE_NONE, D2D1_ROUNDED_RECT,
            },
            DirectWrite::{
                DWriteCreateFactory, IDWriteFactory, IDWriteTextFormat, DWRITE_FACTORY_TYPE_SHARED,
                DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT_BOLD,
                DWRITE_FONT_WEIGHT_NORMAL, DWRITE_MEASURING_MODE_NATURAL,
                DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_TEXT_ALIGNMENT_TRAILING,
                DWRITE_WORD_WRAPPING_NO_WRAP,
            },
            Dxgi::Common::DXGI_FORMAT_UNKNOWN,
        },
    },
};
use windows_numerics::{Matrix3x2, Vector2};

pub const TITLEBAR_HEIGHT: i32 = 34;
pub const RESULT_TOP: i32 = 222 + TITLEBAR_HEIGHT;
const RESULT_CONTENT_TOP: f32 = 284.0 + TITLEBAR_HEIGHT as f32;

#[derive(Clone, Copy)]
pub enum LineStyle {
    Heading,
    Section,
    Body,
    Muted,
    Error,
}

#[derive(Clone)]
pub struct DisplayLine {
    pub text: String,
    pub style: LineStyle,
    pub indent: f32,
}

pub struct Renderer {
    factory: ID2D1Factory,
    dwrite: IDWriteFactory,
    target: Option<ID2D1HwndRenderTarget>,
    width: u32,
    height: u32,
}

impl Renderer {
    pub fn new() -> Result<Self> {
        unsafe {
            Ok(Self {
                factory: D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?,
                dwrite: DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?,
                target: None,
                width: 0,
                height: 0,
            })
        }
    }

    pub fn content_height(lines: &[DisplayLine], width: u32) -> i32 {
        let text_width = width.saturating_sub(40).max(160);
        lines
            .iter()
            .map(|line| {
                let wrapped =
                    wrapped_line_count(&line.text, text_width, line.indent, font_size(line.style));
                line_height(line.style) as i32 * wrapped as i32
            })
            .sum::<i32>()
            + RESULT_CONTENT_TOP as i32
            + 18
    }

    unsafe fn ensure_target(&mut self, hwnd: HWND, width: u32, height: u32) -> Result<()> {
        if let Some(target) = &self.target {
            if self.width != width || self.height != height {
                target.Resize(&D2D_SIZE_U { width, height })?;
            }
            self.width = width;
            self.height = height;
            return Ok(());
        }

        let render_properties = D2D1_RENDER_TARGET_PROPERTIES {
            r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_UNKNOWN,
                alphaMode: D2D1_ALPHA_MODE_IGNORE,
            },
            dpiX: 0.0,
            dpiY: 0.0,
            usage: D2D1_RENDER_TARGET_USAGE_NONE,
            minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
        };
        let hwnd_properties = D2D1_HWND_RENDER_TARGET_PROPERTIES {
            hwnd,
            pixelSize: D2D_SIZE_U { width, height },
            presentOptions: D2D1_PRESENT_OPTIONS_NONE,
        };
        self.target = Some(
            self.factory
                .CreateHwndRenderTarget(&render_properties, &hwnd_properties)?,
        );
        self.width = width;
        self.height = height;
        Ok(())
    }

    pub unsafe fn resize(&mut self, width: u32, height: u32) {
        self.width = width;
        self.height = height;
        if let Some(target) = &self.target {
            let _ = target.Resize(&D2D_SIZE_U { width, height });
        }
    }

    pub unsafe fn paint(
        &mut self,
        hwnd: HWND,
        width: u32,
        height: u32,
        scroll_y: i32,
        query: &str,
        header: &str,
        loading: bool,
        source_language: &str,
        target_language: &str,
        selection_status: &str,
        request_status: &str,
        history: &[String],
        history_open: bool,
        lines: &[DisplayLine],
    ) {
        if width == 0 || height == 0 || self.ensure_target(hwnd, width, height).is_err() {
            return;
        }
        let Some(target) = self.target.as_ref() else {
            return;
        };

        target.BeginDraw();
        target.Clear(Some(&color(0.973, 0.973, 0.965)));

        let Some(ink) = self.brush(target, color(0.14, 0.15, 0.17)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(muted) = self.brush(target, color(0.48, 0.50, 0.53)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(blue) = self.brush(target, color(0.30, 0.45, 0.91)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(green) = self.brush(target, color(0.18, 0.60, 0.46)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(section) = self.brush(target, color(0.11, 0.45, 0.38)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(error) = self.brush(target, color(0.73, 0.28, 0.28)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(query_fill) = self.brush(target, color(0.929, 0.929, 0.922)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(titlebar_fill) = self.brush(target, color(0.973, 0.973, 0.965)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(language_fill) = self.brush(target, color(0.906, 0.906, 0.894)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(panel) = self.brush(target, color(1.0, 1.0, 1.0)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(line_brush) = self.brush(target, color(0.91, 0.91, 0.90)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(tool_brush) = self.brush(target, color(0.57, 0.59, 0.61)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(badge_fill) = self.brush(target, color(0.941, 0.953, 0.988)) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(icon_white) = self.brush(target, color(1.0, 1.0, 1.0)) else {
            let _ = target.EndDraw(None, None);
            return;
        };

        let Some(ui_format) = self.format(11.0, false, false) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(ui_bold_format) = self.format(11.0, true, false) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(ui_right_format) = self.format(10.0, false, true) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(result_meta_format) = self.format(9.0, true, false) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(result_query_format) = self.format(17.0, true, false) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(normal_format) = self.format(13.0, false, false) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(heading_format) = self.format(21.0, true, false) else {
            let _ = target.EndDraw(None, None);
            return;
        };
        let Some(section_format) = self.format(13.0, true, false) else {
            let _ = target.EndDraw(None, None);
            return;
        };

        let top_bar = TITLEBAR_HEIGHT as f32;
        let query_top = top_bar + 8.0;
        let language_top = top_bar + 104.0;
        let status_top = top_bar + 190.0;

        self.draw_titlebar(
            target,
            width,
            &ink,
            &muted,
            &blue,
            &line_brush,
            &titlebar_fill,
            &icon_white,
            &ui_bold_format,
        );

        self.fill_round(
            target,
            &D2D_RECT_F {
                left: 8.0,
                top: query_top,
                right: width.saturating_sub(8) as f32,
                bottom: query_top + 88.0,
            },
            &query_fill,
            11.0,
        );
        self.outline_round(
            target,
            &D2D_RECT_F {
                left: 8.0,
                top: query_top,
                right: width.saturating_sub(8) as f32,
                bottom: query_top + 88.0,
            },
            &line_brush,
            11.0,
        );
        self.draw_query_tools(target, width, top_bar, &tool_brush);
        self.fill_round(
            target,
            &D2D_RECT_F {
                left: 8.0,
                top: language_top,
                right: width.saturating_sub(8) as f32,
                bottom: language_top + 34.0,
            },
            &language_fill,
            9.0,
        );
        self.outline_round(
            target,
            &D2D_RECT_F {
                left: 8.0,
                top: language_top,
                right: width.saturating_sub(8) as f32,
                bottom: language_top + 34.0,
            },
            &line_brush,
            9.0,
        );
        self.draw_text(
            target,
            source_language,
            &ui_bold_format,
            &ink,
            D2D_RECT_F {
                left: 18.0,
                top: language_top + 7.0,
                right: width as f32 * 0.46,
                bottom: language_top + 28.0,
            },
        );
        self.draw_text(
            target,
            "⇄",
            &ui_bold_format,
            &muted,
            D2D_RECT_F {
                left: width as f32 * 0.46,
                top: language_top + 6.0,
                right: width as f32 * 0.54,
                bottom: language_top + 29.0,
            },
        );
        self.draw_text(
            target,
            target_language,
            &ui_bold_format,
            &ink,
            D2D_RECT_F {
                left: width as f32 * 0.54,
                top: language_top + 7.0,
                right: width.saturating_sub(18) as f32,
                bottom: language_top + 28.0,
            },
        );

        self.fill_round(
            target,
            &D2D_RECT_F {
                left: 10.0,
                top: status_top + 8.0,
                right: 16.0,
                bottom: status_top + 14.0,
            },
            &green,
            3.0,
        );
        self.draw_text(
            target,
            selection_status,
            &ui_format,
            &muted,
            D2D_RECT_F {
                left: 20.0,
                top: status_top,
                right: width as f32 * 0.57,
                bottom: status_top + 24.0,
            },
        );
        self.draw_text(
            target,
            request_status,
            &ui_right_format,
            &muted,
            D2D_RECT_F {
                left: width as f32 * 0.43,
                top: status_top,
                right: width.saturating_sub(18) as f32,
                bottom: status_top + 24.0,
            },
        );

        self.fill_round(
            target,
            &D2D_RECT_F {
                left: 8.0,
                top: RESULT_TOP as f32,
                right: width.saturating_sub(8) as f32,
                bottom: height.max(RESULT_TOP as u32 + 30) as f32,
            },
            &panel,
            11.0,
        );
        self.outline_round(
            target,
            &D2D_RECT_F {
                left: 8.0,
                top: RESULT_TOP as f32,
                right: width.saturating_sub(8) as f32,
                bottom: height.max(RESULT_TOP as u32 + 30) as f32,
            },
            &line_brush,
            11.0,
        );

        let body_clip = D2D_RECT_F {
            left: 9.0,
            top: RESULT_CONTENT_TOP,
            right: width.saturating_sub(9) as f32,
            bottom: height.saturating_sub(9) as f32,
        };
        let _ = target.PushAxisAlignedClip(&body_clip, D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
        let mut y = RESULT_CONTENT_TOP - scroll_y as f32;
        for line in lines {
            let (format, brush, line_height, font_size): (&IDWriteTextFormat, &_, f32, f32) =
                match line.style {
                    LineStyle::Heading => (&heading_format, &blue, 30.0_f32, 21.0_f32),
                    LineStyle::Section => (&section_format, &section, 24.0_f32, 13.0_f32),
                    LineStyle::Body => (&normal_format, &ink, 19.0_f32, 13.0_f32),
                    LineStyle::Muted => (&normal_format, &muted, 19.0_f32, 13.0_f32),
                    LineStyle::Error => (&normal_format, &error, 21.0_f32, 13.0_f32),
                };
            for text in wrap_text(
                &line.text,
                wrapped_text_capacity(width, line.indent, font_size),
            ) {
                let top = y;
                let rect = D2D_RECT_F {
                    left: 20.0 + line.indent,
                    top,
                    right: width.saturating_sub(20) as f32,
                    bottom: top + line_height,
                };
                if rect.bottom >= RESULT_CONTENT_TOP && rect.top <= height as f32 {
                    self.draw_text(target, &text, format, brush, rect);
                }
                y += line_height;
            }
        }
        let _ = target.PopAxisAlignedClip();

        // Cover the scrolling text under the fixed result header, like the Tauri card.
        target.FillRectangle(
            &D2D_RECT_F {
                left: 9.0,
                top: RESULT_TOP as f32 + 1.0,
                right: width.saturating_sub(9) as f32,
                bottom: RESULT_CONTENT_TOP - 4.0,
            },
            &panel,
        );
        let empty_query = query.is_empty();
        self.draw_text(
            target,
            if empty_query { "MEDICT" } else { header },
            &result_meta_format,
            &muted,
            D2D_RECT_F {
                left: 20.0,
                top: RESULT_TOP as f32 + 10.0,
                right: width as f32 * 0.42,
                bottom: RESULT_TOP as f32 + 26.0,
            },
        );
        self.draw_text(
            target,
            if empty_query { "查词助手" } else { query },
            &result_query_format,
            &ink,
            D2D_RECT_F {
                left: 20.0,
                top: RESULT_TOP as f32 + 25.0,
                right: width as f32 * 0.72,
                bottom: RESULT_TOP as f32 + 54.0,
            },
        );
        let badge = if empty_query {
            ""
        } else if loading {
            "查询中…"
        } else if header == "DRUG" {
            "DrugShop"
        } else {
            "网易有道词典"
        };
        if !badge.is_empty() {
            self.fill_round(
                target,
                &D2D_RECT_F {
                    left: width.saturating_sub(118) as f32,
                    top: RESULT_TOP as f32 + 12.0,
                    right: width.saturating_sub(18) as f32,
                    bottom: RESULT_TOP as f32 + 32.0,
                },
                &badge_fill,
                10.0,
            );
            self.draw_text(
                target,
                badge,
                &result_meta_format,
                &blue,
                D2D_RECT_F {
                    left: width.saturating_sub(113) as f32,
                    top: RESULT_TOP as f32 + 14.0,
                    right: width.saturating_sub(23) as f32,
                    bottom: RESULT_TOP as f32 + 30.0,
                },
            );
        }
        target.FillRectangle(
            &D2D_RECT_F {
                left: 20.0,
                top: RESULT_CONTENT_TOP - 4.0,
                right: width.saturating_sub(20) as f32,
                bottom: RESULT_CONTENT_TOP - 3.0,
            },
            &line_brush,
        );
        if history_open {
            self.draw_history(
                target,
                width,
                history,
                &panel,
                &line_brush,
                &ink,
                &muted,
                &blue,
                &ui_format,
                &ui_right_format,
                &result_meta_format,
            );
        }
        let _ = target.EndDraw(None, None);
    }

    unsafe fn draw_titlebar(
        &self,
        target: &ID2D1HwndRenderTarget,
        width: u32,
        ink: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        muted: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        blue: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        line_brush: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        titlebar_fill: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        icon_white: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        title_format: &IDWriteTextFormat,
    ) {
        let width = width as f32;
        // Paint the whole titlebar with the same desktop-return background. The
        // previous version only painted a one-pixel strip at its bottom.
        let _ = target.FillRectangle(
            &D2D_RECT_F {
                left: 0.0,
                top: 0.0,
                right: width,
                bottom: TITLEBAR_HEIGHT as f32,
            },
            titlebar_fill,
        );
        let _ = target.FillRectangle(
            &D2D_RECT_F {
                left: 0.0,
                top: TITLEBAR_HEIGHT as f32 - 1.0,
                right: width,
                bottom: TITLEBAR_HEIGHT as f32,
            },
            line_brush,
        );

        // Use the same atomic-orbit mark as the Tauri app icon, without the
        // extra pin/T-shaped glyph that used to precede it.
        self.fill_round(
            target,
            &D2D_RECT_F {
                left: 10.0,
                top: 8.0,
                right: 28.0,
                bottom: 26.0,
            },
            blue,
            5.0,
        );
        let center = Vector2 { X: 19.0, Y: 17.0 };
        let _ = target.DrawEllipse(
            &D2D1_ELLIPSE {
                point: center,
                radiusX: 7.0,
                radiusY: 2.7,
            },
            icon_white,
            1.0,
            None,
        );
        let rotate_plus = Matrix3x2::rotation_around(60.0, center);
        let _ = target.SetTransform(&rotate_plus);
        let _ = target.DrawEllipse(
            &D2D1_ELLIPSE {
                point: center,
                radiusX: 7.0,
                radiusY: 2.7,
            },
            icon_white,
            1.0,
            None,
        );
        let rotate_minus = Matrix3x2::rotation_around(-60.0, center);
        let _ = target.SetTransform(&rotate_minus);
        let _ = target.DrawEllipse(
            &D2D1_ELLIPSE {
                point: center,
                radiusX: 7.0,
                radiusY: 2.7,
            },
            icon_white,
            1.0,
            None,
        );
        let identity = Matrix3x2::identity();
        let _ = target.SetTransform(&identity);
        let _ = target.FillEllipse(
            &D2D1_ELLIPSE {
                point: center,
                radiusX: 2.1,
                radiusY: 2.1,
            },
            icon_white,
        );
        self.draw_text(
            target,
            "Medict",
            title_format,
            ink,
            D2D_RECT_F {
                left: 36.0,
                top: 7.0,
                right: 135.0,
                bottom: 27.0,
            },
        );

        // Eight teeth make this a gear, rather than the location/cross glyph
        // produced by the old four-direction drawing.
        let settings_x = width - 80.0;
        let _ = target.DrawEllipse(
            &D2D1_ELLIPSE {
                point: Vector2 {
                    X: settings_x,
                    Y: 17.0,
                },
                radiusX: 5.5,
                radiusY: 5.5,
            },
            muted,
            1.6,
            None,
        );
        let _ = target.FillEllipse(
            &D2D1_ELLIPSE {
                point: Vector2 {
                    X: settings_x,
                    Y: 17.0,
                },
                radiusX: 2.0,
                radiusY: 2.0,
            },
            titlebar_fill,
        );
        for (dx, dy) in [
            (0.0_f32, -8.0_f32),
            (5.7, -5.7),
            (8.0, 0.0),
            (5.7, 5.7),
            (0.0, 8.0),
            (-5.7, 5.7),
            (-8.0, 0.0),
            (-5.7, -5.7),
        ] {
            let _ = target.DrawLine(
                Vector2 {
                    X: settings_x + dx * 0.62,
                    Y: 17.0 + dy * 0.62,
                },
                Vector2 {
                    X: settings_x + dx * 0.94,
                    Y: 17.0 + dy * 0.94,
                },
                muted,
                1.8,
                None,
            );
        }
        let _ = target.DrawLine(
            Vector2 {
                X: width - 55.0,
                Y: 17.0,
            },
            Vector2 {
                X: width - 43.0,
                Y: 17.0,
            },
            muted,
            1.6,
            None,
        );
        let _ = target.DrawLine(
            Vector2 {
                X: width - 28.0,
                Y: 11.0,
            },
            Vector2 {
                X: width - 16.0,
                Y: 23.0,
            },
            muted,
            1.6,
            None,
        );
        let _ = target.DrawLine(
            Vector2 {
                X: width - 16.0,
                Y: 11.0,
            },
            Vector2 {
                X: width - 28.0,
                Y: 23.0,
            },
            muted,
            1.6,
            None,
        );
    }

    unsafe fn draw_history(
        &self,
        target: &ID2D1HwndRenderTarget,
        width: u32,
        history: &[String],
        panel: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        line_brush: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        ink: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        muted: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        blue: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        ui_format: &IDWriteTextFormat,
        ui_right_format: &IDWriteTextFormat,
        meta_format: &IDWriteTextFormat,
    ) {
        let right = width.saturating_sub(15) as f32;
        let left = width.saturating_sub(320).max(18) as f32;
        // Child controls sit above the Direct2D surface, so keep the popover in
        // the result card rather than letting the native action buttons cover it.
        let top = RESULT_TOP as f32 + 12.0;
        let rows = history.len().min(10);
        let bottom = top
            + 34.0
            + if rows == 0 {
                40.0
            } else {
                rows as f32 * 30.0 + 8.0
            };
        self.fill_round(
            target,
            &D2D_RECT_F {
                left,
                top,
                right,
                bottom,
            },
            panel,
            10.0,
        );
        self.outline_round(
            target,
            &D2D_RECT_F {
                left,
                top,
                right,
                bottom,
            },
            line_brush,
            10.0,
        );
        self.draw_text(
            target,
            "最近查询",
            ui_format,
            muted,
            D2D_RECT_F {
                left: left + 11.0,
                top: top + 8.0,
                right: left + 100.0,
                bottom: top + 26.0,
            },
        );
        self.draw_text(
            target,
            "最多 10 条",
            meta_format,
            muted,
            D2D_RECT_F {
                left: right - 76.0,
                top: top + 9.0,
                right: right - 10.0,
                bottom: top + 25.0,
            },
        );
        if rows == 0 {
            self.draw_text(
                target,
                "暂无查询记录",
                ui_format,
                muted,
                D2D_RECT_F {
                    left: left + 10.0,
                    top: top + 39.0,
                    right: right - 10.0,
                    bottom: top + 62.0,
                },
            );
            return;
        }
        for (index, query) in history.iter().take(10).enumerate() {
            let row_top = top + 31.0 + index as f32 * 30.0;
            let clipped = if query.chars().count() > 31 {
                format!("{}…", query.chars().take(30).collect::<String>())
            } else {
                query.clone()
            };
            self.draw_text(
                target,
                &clipped,
                ui_format,
                ink,
                D2D_RECT_F {
                    left: left + 11.0,
                    top: row_top + 4.0,
                    right: right - 58.0,
                    bottom: row_top + 25.0,
                },
            );
            self.fill_round(
                target,
                &D2D_RECT_F {
                    left: right - 50.0,
                    top: row_top + 6.0,
                    right: right - 11.0,
                    bottom: row_top + 22.0,
                },
                line_brush,
                8.0,
            );
            self.draw_text(
                target,
                "查词",
                meta_format,
                blue,
                D2D_RECT_F {
                    left: right - 47.0,
                    top: row_top + 7.0,
                    right: right - 14.0,
                    bottom: row_top + 21.0,
                },
            );
        }
        let _ = ui_right_format;
    }

    unsafe fn draw_text(
        &self,
        target: &ID2D1HwndRenderTarget,
        text: &str,
        format: &IDWriteTextFormat,
        brush: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        rect: D2D_RECT_F,
    ) {
        let text = text.encode_utf16().collect::<Vec<u16>>();
        let _ = target.DrawText(
            &text,
            format,
            &rect,
            brush,
            D2D1_DRAW_TEXT_OPTIONS_NONE,
            DWRITE_MEASURING_MODE_NATURAL,
        );
    }

    unsafe fn fill_round(
        &self,
        target: &ID2D1HwndRenderTarget,
        rect: &D2D_RECT_F,
        brush: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        radius: f32,
    ) {
        let rounded = D2D1_ROUNDED_RECT {
            rect: *rect,
            radiusX: radius,
            radiusY: radius,
        };
        let _ = target.FillRoundedRectangle(&rounded, brush);
    }

    unsafe fn outline_round(
        &self,
        target: &ID2D1HwndRenderTarget,
        rect: &D2D_RECT_F,
        brush: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
        radius: f32,
    ) {
        let rounded = D2D1_ROUNDED_RECT {
            rect: *rect,
            radiusX: radius,
            radiusY: radius,
        };
        let _ = target.DrawRoundedRectangle(&rounded, brush, 1.0, None);
    }

    unsafe fn draw_query_tools(
        &self,
        target: &ID2D1HwndRenderTarget,
        width: u32,
        top_bar: f32,
        brush: &windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush,
    ) {
        let right = width.saturating_sub(20) as f32;
        let y = top_bar + 75.0;
        // Copy icon: two clean, rounded offset sheets.
        let _ = target.DrawRoundedRectangle(
            &D2D1_ROUNDED_RECT {
                rect: D2D_RECT_F {
                    left: right - 65.0,
                    top: y - 5.0,
                    right: right - 55.0,
                    bottom: y + 6.0,
                },
                radiusX: 1.5,
                radiusY: 1.5,
            },
            brush,
            1.25,
            None,
        );
        let _ = target.DrawRoundedRectangle(
            &D2D1_ROUNDED_RECT {
                rect: D2D_RECT_F {
                    left: right - 62.0,
                    top: y - 2.0,
                    right: right - 52.0,
                    bottom: y + 9.0,
                },
                radiusX: 1.5,
                radiusY: 1.5,
            },
            brush,
            1.25,
            None,
        );

        // History icon: a simple clock and a return hand.
        let clock = D2D1_ELLIPSE {
            point: Vector2 {
                X: right - 30.0,
                Y: y,
            },
            radiusX: 5.5,
            radiusY: 5.5,
        };
        let _ = target.DrawEllipse(&clock, brush, 1.2, None);
        let _ = target.DrawLine(
            Vector2 {
                X: right - 30.0,
                Y: y - 3.0,
            },
            Vector2 {
                X: right - 30.0,
                Y: y,
            },
            brush,
            1.2,
            None,
        );
        let _ = target.DrawLine(
            Vector2 {
                X: right - 30.0,
                Y: y,
            },
            Vector2 {
                X: right - 27.0,
                Y: y + 2.0,
            },
            brush,
            1.2,
            None,
        );
        let _ = target.DrawLine(
            Vector2 {
                X: right - 35.0,
                Y: y - 1.0,
            },
            Vector2 {
                X: right - 32.0,
                Y: y - 4.0,
            },
            brush,
            1.2,
            None,
        );
        let _ = target.DrawLine(
            Vector2 {
                X: right - 35.0,
                Y: y - 1.0,
            },
            Vector2 {
                X: right - 31.0,
                Y: y + 1.0,
            },
            brush,
            1.2,
            None,
        );

        // Trash icon: lid, handle and body.
        let _ = target.DrawRectangle(
            &D2D_RECT_F {
                left: right - 10.0,
                top: y - 5.0,
                right: right + 2.0,
                bottom: y - 3.5,
            },
            brush,
            1.2,
            None,
        );
        for x in [right - 6.0, right - 3.0] {
            let _ = target.DrawLine(
                Vector2 { X: x, Y: y - 1.0 },
                Vector2 { X: x, Y: y + 6.5 },
                brush,
                1.0,
                None,
            );
        }
        let _ = target.DrawRectangle(
            &D2D_RECT_F {
                left: right - 5.5,
                top: y - 7.5,
                right: right - 2.5,
                bottom: y - 5.0,
            },
            brush,
            1.2,
            None,
        );
        let _ = target.DrawRoundedRectangle(
            &D2D1_ROUNDED_RECT {
                rect: D2D_RECT_F {
                    left: right - 8.5,
                    top: y - 3.0,
                    right: right + 0.5,
                    bottom: y + 8.5,
                },
                radiusX: 1.5,
                radiusY: 1.5,
            },
            brush,
            1.2,
            None,
        );
    }

    unsafe fn brush(
        &self,
        target: &ID2D1HwndRenderTarget,
        color: D2D1_COLOR_F,
    ) -> Option<windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush> {
        target.CreateSolidColorBrush(&color, None).ok()
    }

    unsafe fn format(&self, size: f32, bold: bool, trailing: bool) -> Option<IDWriteTextFormat> {
        let weight = if bold {
            DWRITE_FONT_WEIGHT_BOLD
        } else {
            DWRITE_FONT_WEIGHT_NORMAL
        };
        let format = self
            .dwrite
            .CreateTextFormat(
                w!("Segoe UI"),
                None,
                weight,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                size,
                w!("zh-CN"),
            )
            .ok()?;
        let _ = format.SetTextAlignment(if trailing {
            DWRITE_TEXT_ALIGNMENT_TRAILING
        } else {
            DWRITE_TEXT_ALIGNMENT_LEADING
        });
        let _ = format.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
        Some(format)
    }
}

fn color(r: f32, g: f32, b: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F { r, g, b, a: 1.0 }
}

fn line_height(style: LineStyle) -> f32 {
    match style {
        LineStyle::Heading => 30.0,
        LineStyle::Section => 24.0,
        LineStyle::Body => 19.0,
        LineStyle::Muted => 19.0,
        LineStyle::Error => 21.0,
    }
}

fn wrapped_text_capacity(width: u32, indent: f32, font_size: f32) -> f32 {
    let available = (width as f32 - 40.0 - indent).max(160.0);
    (available / font_size.max(10.0)).max(12.0)
}

fn wrapped_line_count(text: &str, width: u32, indent: f32, font_size: f32) -> usize {
    wrap_text(text, wrapped_text_capacity(width, indent, font_size)).len()
}

fn wrap_text(text: &str, capacity: f32) -> Vec<String> {
    let capacity = capacity.max(1.0);
    let mut lines = Vec::new();
    for segment in text.split('\n') {
        if segment.is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut line = String::new();
        let mut line_width = 0.0_f32;
        for character in segment.chars() {
            let character_width = if character.is_ascii() { 0.56 } else { 1.0 };
            if !line.is_empty() && line_width + character_width > capacity {
                lines.push(std::mem::take(&mut line));
                line_width = 0.0;
            }
            line.push(character);
            line_width += character_width;
        }
        if !line.is_empty() {
            lines.push(line);
        }
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn font_size(style: LineStyle) -> f32 {
    match style {
        LineStyle::Heading => 21.0,
        LineStyle::Section | LineStyle::Body | LineStyle::Muted | LineStyle::Error => 13.0,
    }
}
