//! Pure initial placement in logical display pixels, including small/HiDPI displays.
use gpui::{Bounds, Pixels, Size, point, px, size};

pub(crate) fn initial_window_bounds(display: Bounds<Pixels>) -> (Bounds<Pixels>, Size<Pixels>) {
    // GPUI 0.2.2 exposes display bounds, not work area; reserve room for desktop/window chrome.
    let available = size(
        (display.size.width - px(32.)).max(px(1.)),
        (display.size.height - px(96.)).max(px(1.)),
    );
    let content = size(
        available.width.min(px(1120.)),
        available.height.min(px(820.)),
    );
    let origin = point(
        display.origin.x + (display.size.width - content.width) / 2.,
        display.origin.y + (display.size.height - content.height) / 2.,
    );
    let minimum = size(content.width.min(px(760.)), content.height.min(px(520.)));
    (Bounds::new(origin, content), minimum)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tart_1024_by_768_fits_without_negative_origin() {
        let display = Bounds::new(point(px(0.), px(0.)), size(px(1024.), px(768.)));
        let (bounds, minimum) = initial_window_bounds(display);
        assert_eq!(bounds.origin, point(px(16.), px(48.)));
        assert_eq!(bounds.size, size(px(992.), px(672.)));
        assert_eq!(minimum, size(px(760.), px(520.)));
    }

    #[test]
    fn typical_desktop_keeps_preferred_size_and_centers_on_its_origin() {
        let display = Bounds::new(point(px(1920.), px(100.)), size(px(1920.), px(1080.)));
        let (bounds, minimum) = initial_window_bounds(display);
        assert_eq!(bounds.size, size(px(1120.), px(820.)));
        assert_eq!(bounds.origin, point(px(2320.), px(230.)));
        assert_eq!(minimum, size(px(760.), px(520.)));
    }

    #[test]
    fn small_viewports_never_force_a_larger_minimum_or_offscreen_bounds() {
        for (width, height) in [(800., 600.), (640., 480.), (320., 240.), (24., 80.)] {
            let display = Bounds::new(point(px(0.), px(0.)), size(px(width), px(height)));
            let (bounds, minimum) = initial_window_bounds(display);
            assert!(bounds.origin.x >= px(0.) && bounds.origin.y >= px(0.));
            assert!(bounds.origin.x + bounds.size.width <= display.size.width);
            assert!(bounds.origin.y + bounds.size.height <= display.size.height);
            assert!(minimum.width <= bounds.size.width && minimum.height <= bounds.size.height);
            assert!(minimum.width > px(0.) && minimum.height > px(0.));
        }
    }
}
