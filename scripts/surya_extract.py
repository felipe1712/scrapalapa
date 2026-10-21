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

        for i in range(page_count):
            page = pdf[i]
            textpage = page.get_textpage()
            extracted = textpage.get_text_range().strip()
            if not force_ocr and len(extracted) > 80:
                pages_text.append((i, extracted))
            else:
                bitmap = page.render(scale=2.0)
                pil_img = bitmap.to_pil()
                pages_needing_ocr.append(i)
                pil_images.append(pil_img)

        if len(pil_images) > 0:
            try:
                from surya.recognition import RecognitionPredictor
                from surya.detection import DetectionPredictor

                det_predictor = DetectionPredictor()
                rec_predictor = RecognitionPredictor()
                predictions = rec_predictor(pil_images, [None] * len(pil_images), det_predictor)
                used_surya = True

                for idx, pred in zip(pages_needing_ocr, predictions):
                    line_texts = [line.text for line in pred.text_lines if getattr(line, "text", None)]
                    pages_text.append((idx, "\n".join(line_texts)))
            except Exception as surya_err:
                # Si Surya no está disponible o falla en alguna página, conservar lo extraído por pypdfium2
                for idx in pages_needing_ocr:
                    page = pdf[idx]
                    fallback_txt = page.get_textpage().get_text_range().strip()
                    pages_text.append((idx, fallback_txt or f"[Página {idx + 1} sin capa de texto ({surya_err})]"))

        pages_text.sort(key=lambda x: x[0])
        full_text = "\n\n".join([f"--- PÁGINA {idx + 1} ---\n{txt}" for idx, txt in pages_text if txt])

        return {
            "ok": True,
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
    print(json.dumps(res, ensure_ascii=False))

if __name__ == "__main__":
    main()
