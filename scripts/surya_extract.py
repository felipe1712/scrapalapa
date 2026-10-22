#!/usr/bin/env python3
"""
Puente de extracción documental e imagen para PDFs digitales y escaneados.
Soporta:
1. Extracción nativa de capa de texto con pypdfium2
2. OCR local de imágenes con Tesseract (spa+eng) y/o Surya OCR
3. Exportación de páginas escaneadas renderizadas en JPEG (base64) para OCR Multimodal de alta precisión cuando el PDF está compuesto por imágenes.
"""
import sys
import os
import io
import json
import base64
import shutil
import argparse
import contextlib

os.environ["TQDM_DISABLE"] = "1"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"


def run_tesseract_on_image(pil_img) -> str:
    """Intenta OCR rápido en CPU con Tesseract (español + inglés)."""
    try:
        import pytesseract
        if not shutil.which("tesseract"):
            return ""
        for lang in ["spa+eng", "spa", "eng"]:
            try:
                txt = pytesseract.image_to_string(pil_img, lang=lang)
                if txt and len(txt.strip()) > 20:
                    return txt.strip()
            except Exception:
                continue
    except Exception:
        pass
    return ""


def run_surya_on_images(pil_images):
    """Ejecuta Surya OCR redirigiendo logs a stderr."""
    with contextlib.redirect_stdout(sys.stderr):
        from surya.detection import DetectionPredictor
        from surya.recognition import RecognitionPredictor

        det_predictor = DetectionPredictor()
        try:
            from surya.foundation import FoundationPredictor
            foundation_predictor = FoundationPredictor()
            rec_predictor = RecognitionPredictor(foundation_predictor)
            return rec_predictor(pil_images, det_predictor=det_predictor)
        except ImportError:
            rec_predictor = RecognitionPredictor()
            return rec_predictor(pil_images, [None] * len(pil_images), det_predictor)


def encode_pil_to_jpeg_b64(pil_img, max_dim=1600, quality=78) -> str:
    """Convierte una página PIL a JPEG base64 optimizado para OCR de imagen."""
    img = pil_img.convert("RGB")
    w, h = img.size
    if max(w, h) > max_dim:
        scale = max_dim / float(max(w, h))
        img = img.resize((int(w * scale), int(h * scale)))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def extract_pdf(file_path: str, force_ocr: bool = False):
    pages_text = []
    rendered_pages_b64 = []
    method_used = "surya_hybrid_pdf"
    page_count = 0

    try:
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(file_path)
        page_count = len(pdf)

        pages_needing_ocr = []
        pil_images = []
        max_ocr_pages = 15

        for i in range(page_count):
            page = pdf[i]
            textpage = page.get_textpage()
            extracted = textpage.get_text_range().strip()
            if not force_ocr and len(extracted) > 80:
                pages_text.append((i, extracted))
            elif len(pil_images) < max_ocr_pages:
                bitmap = page.render(scale=1.8)
                pil_img = bitmap.to_pil()
                pages_needing_ocr.append(i)
                pil_images.append(pil_img)
            else:
                if extracted:
                    pages_text.append((i, extracted))

        if len(pil_images) > 0:
            # 1. Intentar primero Tesseract si está disponible (muy rápido en CPU para tablas escaneadas)
            tesseract_succeeded = False
            if shutil.which("tesseract"):
                tess_results = []
                for idx, img in zip(pages_needing_ocr, pil_images):
                    t_txt = run_tesseract_on_image(img)
                    if t_txt:
                        tess_results.append((idx, t_txt))
                if len(tess_results) == len(pages_needing_ocr):
                    pages_text.extend(tess_results)
                    method_used = "tesseract_ocr"
                    tesseract_succeeded = True

            # 2. Si Tesseract no procesó todas las páginas, intentar Surya OCR
            surya_succeeded = False
            if not tesseract_succeeded:
                try:
                    predictions = run_surya_on_images(pil_images)
                    for idx, pred in zip(pages_needing_ocr, predictions):
                        line_texts = [line.text for line in pred.text_lines if getattr(line, "text", None)]
                        txt_joined = "\n".join(line_texts).strip()
                        if txt_joined:
                            pages_text.append((idx, txt_joined))
                    if len(pages_text) > 0:
                        method_used = "surya_ocr"
                        surya_succeeded = True
                except Exception:
                    surya_succeeded = False

            # 3. Exportar siempre las imágenes JPEG base64 de las páginas escaneadas
            # para permitir OCR Multimodal de alta precisión en tablas e imágenes con firmas cruzadas
            for idx, img in zip(pages_needing_ocr[:10], pil_images[:10]):
                rendered_pages_b64.append({
                    "page": idx + 1,
                    "media_type": "image/jpeg",
                    "data": encode_pil_to_jpeg_b64(img),
                })
            if len(pages_text) == 0:
                method_used = "scanned_images_ready"

        pages_text.sort(key=lambda x: x[0])
        full_text = "\n\n".join([f"--- PÁGINA {idx + 1} ---\n{txt}" for idx, txt in pages_text if txt])

        return {
            "ok": True,
            "method": method_used,
            "pages": page_count,
            "is_scanned": len(pil_images) > 0,
            "text": full_text.strip(),
            "rendered_pages_b64": rendered_pages_b64,
        }
    except Exception as e:
        return {
            "ok": False,
            "method": "surya_error",
            "pages": page_count,
            "error": str(e),
            "text": "",
            "rendered_pages_b64": [],
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file_path", help="Ruta local al archivo PDF")
    parser.add_argument("--mode", default="auto", choices=["auto", "forzar_surya"])
    args = parser.parse_args()

    if not os.path.exists(args.file_path):
        print(json.dumps({"ok": False, "error": "Archivo no encontrado"}))
        sys.exit(1)

    res = extract_pdf(args.file_path, force_ocr=(args.mode == "forzar_surya"))
    sys.stdout.write(json.dumps(res, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
