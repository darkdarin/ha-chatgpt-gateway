"""Assemble ChatGPT Gateway as a local app folder that Home Assistant builds by itself.

    python scripts/build_addon.py            # -> dist/addon/chatgpt_gateway/

Copy the resulting ``chatgpt_gateway`` folder into ``/addons`` on the Home Assistant machine (Samba
or SSH app), then Settings → Apps → App Store → ⋮ → Check for updates; "ChatGPT Gateway" appears
under "Local apps". The Supervisor builds the image on that machine from the bundled sources.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SLUG = "chatgpt_gateway"
# (the root README stays out: the app folder has its own README for the app store)
SOURCES = ["Dockerfile", ".dockerignore", "package.json", "package-lock.json", "LICENSE", "NOTICE",
           "src"]  # fmt: skip


def build(out: Path) -> Path:
    target = out / SLUG
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(ROOT / "addon", target)
    config = target / "config.yaml"  # without "image:" the Supervisor builds the bundled Dockerfile
    config.write_text("".join(
        line for line in config.read_text().splitlines(keepends=True)
        if not line.startswith("image:")
    ))  # fmt: skip
    for name in SOURCES:
        src = ROOT / name
        if src.is_dir():
            shutil.copytree(src, target / name)
        else:
            shutil.copy2(src, target / name)
    return target


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "addon")
    target = build(parser.parse_args().out)
    print(f"app folder: {target}")


if __name__ == "__main__":
    main()
