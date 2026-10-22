#!/usr/bin/env python3
"""
Puente de extracción documental con Surya OCR (https://github.com/VikParuchuri/surya)
Soporta PDFs digitales, PDFs escaneados e imágenes de licitaciones.
Devuelve un objeto JSON en stdout: {"ok": true, "method": "surya_ocr", "pages": N, "text": "..."}
"""
import sys
import os
import json
import argparse
import contextlib

# Evitar barras de progreso en stdout que ensucien la salida JSON
os.environ["TQDM_DISABLE"] = "1"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"


def run_surya_on_images(pil_images):
    """Ejecuta Surya OCR redirigiendo cualquier log de carga de modelos a stderr."""
    with contextlib.redirect_stdout(sys.stderr):
        from surya.detection import DetectionPredictor
        from surya.recognition import RecognitionPredictor

        det_predictor = DetectionPredictor()
        try:
            # Surya >= 0.13 usa FoundationPredictor
            from surya.foundation import FoundationPredictor
            foundation_predictor = FoundationPredictor()
            rec_predictor = RecognitionPredictor(foundation_predictor)
            return rec_predictor(pil_images, det_predictor=det_predictor)
        except ImportError:
            # Surya < 0.13
            rec_predictor = RecognitionPredictor()
            return rec_predictor(pil_images, [None] * len(pil_images), det_predictor)


def extract_with_surya(file_path: str, force_ocr: bool = False):
    pages_text = []
    used_surya = False
    page_count = 0

    try:
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(file_path)
        page_count = len(pdf)

        pages_needing_ocr = []
        pil_images = []

        # Limitar OCR pesado a las primeras 25 páginas si es escaneado para evitar timeouts
        max_ocr_pages = 25

        for i in range(page_count):
            page = pdf[i]
            textpage = page.get_textpage()
            extracted = textpage.get_text_range().strip()
            if not force_ocr and len(extracted) > 60:
                pages_text.append((i, extracted))
            elif len(pil_images) < max_ocr_pages:
                bitmap = page.render(scale=1.75)
                pil_img = bitmap.to_pil()
                pages_needing_ocr.append(i)
                pil_images.append(pil_img)
            else:
                if extracted:
                    pages_text.append((i, extracted))

        if len(pil_images) > 0:
            try:
                predictions = run_surya_on_images(pil_images)
                used_surya = True

                for idx, pred in zip(pages_needing_ocr, predictions):
                    line_texts = [line.text for line in pred.text_lines if getattr(line, "text", None)]
                    pages_text.append((idx, "\n".join(line_texts)))
            except Exception as surya_err:
                for idx in pages_needing_ocr:
                    page = pdf[idx]
                    fallback_txt = page.get_textpage().get_text_range().strip()
                    if fallback_txt:
                        pages_text.append((idx, fallback_txt))

        pages_text.sort(key=lambda x: x[0])
        full_text = "\n\n".join([f"--- PÁGINA {idx + 1} ---\n{txt}" for idx, txt in pages_text if txt])

        return {
            "ok": len(full_text.strip()) > 0,
            "method": "surya_ocr" if used_surya else "surya_hybrid_pdf",
            "pages": page_count,
            "text": full_text.strip(),
        }
    except Exception as e:
        return {
            "ok": False,
            "method": "surya_error",
            "pages": page_count,
            "error": str(e),
            "text": "",
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file_path", help="Ruta local al archivo PDF")
    parser.add_argument("--mode", default="auto", choices=["auto", "forzar_surya"])
    args = parser.parse_args()

    if not os.path.exists(args.file_path):
        print(json.dumps({"ok": False, "error": "Archivo no encontrado"}))
        sys.exit(1)

    res = extract_with_surya(args.file_path, force_ocr=(args.mode == "forzar_surya"))
    sys.stdout.write(json.dumps(res, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
