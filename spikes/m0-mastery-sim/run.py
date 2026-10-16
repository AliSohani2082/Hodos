"""Single entry point for the M0 (e) mastery simulation. See README.md."""

import sys

if __name__ == "__main__":
    if "--golden" in sys.argv:
        from mastery_sim import golden

        golden.write()
        print("wrote", golden.PATH)
