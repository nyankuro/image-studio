"""Regenerate the rendering fixture; normal npm tests only read the saved PDF."""
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


def main():
    specifications = [
        ((144, 216), None, 0, "Portrait 2 x 3 inches"),
        ((216, 144), None, 0, "Landscape 3 x 2 inches"),
        ((288, 288), (72, 36, 216, 252), 0, "Visible CropBox 2 x 3 inches"),
        ((144, 216), None, 90, "Rotation 90 degrees"),
        ((144, 216), None, 180, "Rotation 180 degrees"),
        ((144, 216), None, 270, "Rotation 270 degrees"),
        (A4, None, 0, "A4 - fine text and vector lines"),
    ]
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=specifications[0][0], pageCompression=0)
    for size, crop, _, title in specifications:
        pdf.setPageSize(size)
        left, bottom, right, top = crop or (0, 0, *size)
        pdf.setStrokeColorRGB(1, 0, 0)
        pdf.setLineWidth(0.5)
        pdf.rect(left + 8, bottom + 8, right - left - 16, top - bottom - 16)
        pdf.setFillColorRGB(0, 0, 0)
        pdf.setFont("Helvetica", 6)
        pdf.drawString(left + 12, top - 20, title)
        pdf.drawString(left + 12, top - 32, "Small text: ABC 0123456789")
        pdf.drawString(left + 12, top - 44, "No stretching, trimming or resampling.")
        pdf.setStrokeColorRGB(0, 0, 0)
        pdf.setLineWidth(0.25)
        pdf.line(left + 12, top - 52, right - 12, top - 52)
        pdf.setFillColorRGB(0, 0, 1)
        pdf.circle((left + right) / 2, (bottom + top) / 2, 18, stroke=0, fill=1)
        pdf.showPage()
    pdf.save()
    reader = PdfReader(buffer)
    writer = PdfWriter()
    for page, (_, crop, rotation, _) in zip(reader.pages, specifications):
        if crop:
            page.cropbox = RectangleObject(crop)
        if rotation:
            page.rotate(rotation)
        writer.add_page(page)
    with Path(__file__).with_name("pdf-rendering.pdf").open("wb") as target:
        writer.write(target)


if __name__ == "__main__":
    main()
