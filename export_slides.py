#!/usr/bin/env python3
"""Export the Reentry EOM web presentation to a landscape PDF (one page per slide)."""

import asyncio
import http.server
import os
import sys
import threading
from pathlib import Path

PROJECT_DIR = Path(__file__).parent
PORT = 8765
TOTAL_SLIDES = 32
OUTPUT_PDF = PROJECT_DIR / "Reentry_EOM_Presentation.pdf"
SCREENSHOT_DIR = PROJECT_DIR / "_slides_tmp"

# Seconds to wait after all substeps are revealed for animations to settle.
# Longest GSAP camera tween is 1.2 s; staggered arrow sequences add ~0.75 s more.
SETTLE_SECS = 2.2

# Seconds between substep reveals (each substep can trigger a 3D animation).
SUBSTEP_SECS = 0.9


def start_server() -> http.server.HTTPServer:
    os.chdir(PROJECT_DIR)
    handler = http.server.SimpleHTTPRequestHandler
    handler.log_message = lambda *_: None  # silence request logs
    server = http.server.HTTPServer(("localhost", PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def export_slides() -> None:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("playwright not found — run:  pip install playwright && playwright install chromium")
        sys.exit(1)

    try:
        from PIL import Image
    except ImportError:
        print("Pillow not found — run:  pip install Pillow")
        sys.exit(1)

    SCREENSHOT_DIR.mkdir(exist_ok=True)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--enable-webgl",
                "--ignore-gpu-blocklist",
                "--use-gl=angle",
            ],
        )
        page = await browser.new_page(viewport={"width": 1920, "height": 1080})

        url = f"http://localhost:{PORT}/index.html"
        print(f"Loading {url} ...")
        await page.goto(url, wait_until="domcontentloaded")

        # Wait for the app div to become visible (auto-happens on HTTP because
        # getStoredAssets() returns relative URLs when location.protocol is http:)
        try:
            await page.wait_for_selector("#app", state="visible", timeout=20_000)
        except Exception:
            # Force-dismiss overlay in case something went wrong
            print("  (forcing setup overlay dismissal)")
            await page.evaluate("""
                document.getElementById('setup-overlay').classList.add('hidden');
                document.getElementById('app').style.display = '';
            """)

        # Wait for Three.js boot + first slide render + Earth texture fetch
        print("Waiting for 3D scene to initialise...")
        await asyncio.sleep(4)

        # Confirm goToSlide is reachable (window export worked)
        ok = await page.evaluate("typeof goToSlide === 'function'")
        if not ok:
            print("ERROR: goToSlide not found on window — check index.html exports.")
            await browser.close()
            sys.exit(1)

        print(f"Capturing {TOTAL_SLIDES} slides...")
        for idx in range(TOTAL_SLIDES):
            print(f"  [{idx + 1:2d}/{TOTAL_SLIDES}] ", end="", flush=True)

            await page.evaluate(f"goToSlide({idx})")
            await asyncio.sleep(0.4)  # let enter() fire before reading substep count

            substep_count = await page.evaluate(
                "SLIDES[STATE.currentSlide].substeps "
                "? SLIDES[STATE.currentSlide].substeps.length : 0"
            )

            for s in range(substep_count):
                await page.evaluate("advanceNext()")
                await asyncio.sleep(SUBSTEP_SECS)
                print(".", end="", flush=True)

            await asyncio.sleep(SETTLE_SECS)

            path = str(SCREENSHOT_DIR / f"slide_{idx:02d}.png")
            await page.screenshot(path=path, full_page=False)
            title = await page.evaluate("SLIDES[STATE.currentSlide].title || ''")
            print(f" {title}")

        await browser.close()

    print("\nAssembling PDF...")
    images = [
        Image.open(SCREENSHOT_DIR / f"slide_{i:02d}.png").convert("RGB")
        for i in range(TOTAL_SLIDES)
    ]
    images[0].save(
        OUTPUT_PDF,
        save_all=True,
        append_images=images[1:],
    )
    print(f"Saved: {OUTPUT_PDF}")

    # Clean up temp screenshots
    for i in range(TOTAL_SLIDES):
        (SCREENSHOT_DIR / f"slide_{i:02d}.png").unlink(missing_ok=True)
    try:
        SCREENSHOT_DIR.rmdir()
    except OSError:
        pass


def main() -> None:
    server = start_server()
    print(f"HTTP server started on port {PORT}")
    try:
        asyncio.run(export_slides())
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
