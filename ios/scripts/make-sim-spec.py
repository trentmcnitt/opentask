#!/usr/bin/env python3
"""Derive project-sim.yml from project.yml.

`project.yml` is canonical and includes the watchOS companion app. Generating
an Xcode project from it requires the watchOS SDK to be installed; on a machine
without it, `xcodegen generate` succeeds but every `xcodebuild` invocation fails
before it reaches a single Swift file — including builds of the iOS app, which
has nothing to do with the watch.

So the simulator spec is the canonical spec minus watchOS, and it is *derived*
rather than maintained: a hand-kept second copy silently misses new targets,
which is precisely how a widget extension ends up building on one spec and not
the other.

The transform:
  1. rename the project OpenTask -> OpenTaskSim (so both .xcodeproj coexist)
  2. drop the watchOS deployment target
  3. drop the OpenTaskWatch target
  4. drop every dependency edge pointing at it

Everything else — including any target added to project.yml later — carries
through untouched.

Usage:  python3 ios/scripts/make-sim-spec.py [--check]
        --check exits non-zero if project-sim.yml is out of date instead of
        rewriting it, which makes this usable as a CI/pre-commit guard.
"""

import argparse
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - environment problem, not a code path
    sys.exit("PyYAML is required: pip3 install pyyaml")

IOS_DIR = Path(__file__).resolve().parent.parent
SOURCE = IOS_DIR / "project.yml"
DEST = IOS_DIR / "project-sim.yml"

WATCH_TARGET = "OpenTaskWatch"
SIM_PROJECT_NAME = "OpenTaskSim"


def strip_watch(spec: dict) -> dict:
    """Return a copy of `spec` with everything watchOS removed."""
    out = dict(spec)
    out["name"] = SIM_PROJECT_NAME

    options = dict(out.get("options", {}))
    deployment = {
        platform: version
        for platform, version in options.get("deploymentTarget", {}).items()
        if platform != "watchOS"
    }
    if deployment:
        options["deploymentTarget"] = deployment
    else:
        options.pop("deploymentTarget", None)
    out["options"] = options

    targets = {}
    for name, target in out.get("targets", {}).items():
        if name == WATCH_TARGET:
            continue
        target = dict(target)
        if "dependencies" in target:
            deps = [d for d in target["dependencies"] if d.get("target") != WATCH_TARGET]
            if deps:
                target["dependencies"] = deps
            else:
                target.pop("dependencies")
        targets[name] = target
    out["targets"] = targets

    return out


def render(spec: dict) -> str:
    return yaml.dump(spec, sort_keys=False, default_flow_style=False, width=4096)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify project-sim.yml is current instead of writing it",
    )
    args = parser.parse_args()

    with SOURCE.open() as handle:
        spec = yaml.safe_load(handle)

    rendered = render(strip_watch(spec))

    if args.check:
        current = DEST.read_text() if DEST.exists() else ""
        if current != rendered:
            print(f"{DEST.name} is out of date — run: python3 ios/scripts/make-sim-spec.py")
            return 1
        print(f"{DEST.name} is up to date")
        return 0

    DEST.write_text(rendered)
    print(f"Wrote {DEST.relative_to(IOS_DIR.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
