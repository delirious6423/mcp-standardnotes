"""Pure crop calibration for labels skipped as graphics by full-frame OCR."""
from PIL import ImageOps


def dark_button_regions(image, words):
    gray = image.convert('L')
    pixels = gray.load()
    rows = {(int(w['top']), int(w['height'])) for w in words
            if w['text'] in ('Enable', 'Reject')}
    regions = []
    for top, height in sorted(rows):
        row = top - max(2, height // 4)
        if not 0 <= row < gray.height:
            continue
        start = None
        for x in range(gray.width + 1):
            dark = x < gray.width and pixels[x, row] < 70
            if dark and start is None:
                start = x
            if not dark and start is not None:
                if x - start >= max(40, height * 3):
                    # Exclude rounded borders: they made Tesseract discard the label.
                    inset = max(4, height * 2 // 3)
                    pad = max(3, height // 2 - 1)
                    box = (start + inset, max(0, top - pad), x - inset,
                           min(gray.height, top + height + pad))
                    crop = gray.crop(box)
                    crop = ImageOps.invert(crop.resize((crop.width * 4, crop.height * 4)))
                    crop = crop.point(lambda value: 255 if value > 128 else 0)
                    regions.append((box, ImageOps.expand(crop, border=16, fill=255)))
                start = None
    return regions


def operation_caption_region(image, words):
    """Preview caption crop under the Operation row; full-frame OCR misreads its 'JSON' as 'SON'.

    Only preprocessing changes: the caller still asserts the exact rendered text.
    """
    operation = next((w for w in words if w['text'] == 'Operation' and int(w['left']) < 40), None)
    if operation is None:
        return None
    bottom = int(operation['top']) + int(operation['height'])
    left = max(0, int(operation['left']) - 2)
    box = (left, bottom + 2, min(image.width, left + 800), min(image.height, bottom + 34))
    crop = image.convert('L').crop(box)
    return box, ImageOps.expand(crop.resize((crop.width * 4, crop.height * 4)), border=16, fill=255)
