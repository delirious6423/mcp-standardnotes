#!/usr/bin/env python3
"""Pure, host-safe image geometry regression; never launches the app or OCR."""
import sys
import unittest
from pathlib import Path
from PIL import Image, ImageDraw
sys.path.insert(0, str(Path(__file__).parent / 'vm'))
from gui_vision import dark_button_regions, operation_caption_region


class DarkButtonRegions(unittest.TestCase):
    def test_interior_excludes_graphical_border_but_retains_label(self):
        image = Image.new('RGB', (160, 100), 'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 30, 110, 62), fill='#18181b')
        draw.rectangle((40, 41, 70, 45), fill='white')
        regions = dark_button_regions(image, [{'text': 'Enable', 'top': '38', 'height': '12'}])
        self.assertEqual(len(regions), 1)
        box, crop = regions[0]
        self.assertEqual(box, (28, 33, 103, 55))
        self.assertEqual(crop.getpixel((0, 0)), 255)
        self.assertEqual(crop.getpixel((16 + (50 - box[0]) * 4, 16 + (43 - box[1]) * 4)), 0)

    def test_ordinary_text_and_window_border_are_not_buttons(self):
        image = Image.new('RGB', (160, 100), 'white')
        ImageDraw.Draw(image).rectangle((0, 0, 159, 99), outline='black')
        self.assertEqual(dark_button_regions(image, [{'text': 'Reject', 'top': '38', 'height': '12'}]), [])

    def test_noninteractive_words_do_not_anchor_crops(self):
        image = Image.new('RGB', (160, 100), 'black')
        self.assertEqual(dark_button_regions(image, [{'text': 'email', 'top': '38', 'height': '12'}]), [])


class OperationCaptionRegion(unittest.TestCase):
    operation = {'text': 'Operation', 'left': '23', 'top': '160', 'height': '13'}

    def test_native_calibrated_geometry_and_scaling(self):
        image = Image.new('RGB', (1000, 400), 'white')
        box, crop = operation_caption_region(image, [self.operation])
        self.assertEqual(box, (21, 175, 821, 207))
        self.assertEqual(crop.size, (800 * 4 + 32, 32 * 4 + 32))
        self.assertEqual(crop.getpixel((0, 0)), 255)

    def test_clamps_to_image_and_ignores_non_label_operation_words(self):
        box, _ = operation_caption_region(Image.new('RGB', (300, 180), 'white'), [self.operation])
        self.assertEqual(box, (21, 175, 300, 180))
        indented = {**self.operation, 'left': '300'}
        self.assertIsNone(operation_caption_region(Image.new('RGB', (1000, 400)), [indented]))
        self.assertIsNone(operation_caption_region(Image.new('RGB', (1000, 400)), [{**self.operation, 'text': 'Operations'}]))


if __name__ == '__main__':
    unittest.main()
