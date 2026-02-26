"""Take periodic screenshots of the portfolio dashboard."""

import asyncio
import re
import shutil
from datetime import datetime
from pathlib import Path

from playwright.async_api import async_playwright


SCREENSHOT_DIR = Path(__file__).parent / "screenshots"
ARCHIVE_DIR = SCREENSHOT_DIR / "archive"
URL = "http://localhost:8000"
INTERVAL_MINUTES = 5


def save_to_archive(filepath):
    """Save screenshot to archive, keeping only the last one per day per mode.

    Archive stores one file per day per mode with a fixed name like
    ``portfolio_20260207_normal.png``.  Each new save overwrites the
    previous one for the same day+mode so the archive stays clean.
    """
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)

    pattern = re.compile(r"portfolio_\d{8}_\d{6}_(normal|anonymous)\.png")
    match = pattern.match(filepath.name)
    if not match:
        return
    mode = match.group(1)
    date_str = datetime.now().strftime("%Y%m%d")
    dest = ARCHIVE_DIR / f"portfolio_{date_str}_{mode}.png"
    shutil.copy2(str(filepath), str(dest))
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Archived: {dest.name}")


async def wait_for_data(page):
    """Wait for the page data to fully load."""
    await page.wait_for_function(
        "document.querySelector('#holdingsBody')?.textContent?.includes('USD') || "
        "document.querySelector('#holdingsBody')?.textContent?.includes('VOO')",
        timeout=60000
    )
    # Extra wait for charts to render
    await asyncio.sleep(5)


async def take_screenshots(browser):
    """Take screenshots in both normal and anonymous modes."""
    SCREENSHOT_DIR.mkdir(exist_ok=True)

    # Remove previous screenshots (they will be replaced)
    for old in SCREENSHOT_DIR.glob("portfolio_*.png"):
        old.unlink()

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    page = await browser.new_page(viewport={"width": 1920, "height": 1080})

    # Screenshot 1: Normal mode
    await page.goto(URL)
    await page.evaluate("localStorage.setItem('anonymousMode', 'false')")
    await page.reload()
    await wait_for_data(page)

    filepath_normal = SCREENSHOT_DIR / f"portfolio_{timestamp}_normal.png"
    await page.screenshot(path=str(filepath_normal), full_page=True)
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Normal mode: {filepath_normal.name}")

    # Screenshot 2: Anonymous mode
    await page.evaluate("localStorage.setItem('anonymousMode', 'true')")
    await page.reload()
    await wait_for_data(page)

    filepath_anon = SCREENSHOT_DIR / f"portfolio_{timestamp}_anonymous.png"
    await page.screenshot(path=str(filepath_anon), full_page=True)
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Anonymous mode: {filepath_anon.name}")

    await page.close()

    # Save latest screenshots to archive (one per day per mode)
    save_to_archive(filepath_normal)
    save_to_archive(filepath_anon)


async def main():
    """Take screenshots periodically."""
    print(f"Portfolio Screenshot Service")
    print(f"============================")
    print(f"Interval: {INTERVAL_MINUTES} minutes")
    print(f"Output: {SCREENSHOT_DIR}")
    print(f"Press Ctrl+C to stop.\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch()

        # Take first screenshot immediately
        print("Taking initial screenshots...")
        await take_screenshots(browser)

        # Then take screenshots at regular intervals
        while True:
            await asyncio.sleep(INTERVAL_MINUTES * 60)
            try:
                await take_screenshots(browser)
            except Exception as e:
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Error: {e}")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
