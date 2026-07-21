#!/usr/bin/env bash
# Run the BASE test suite.
#
# Usage:
#   bash run_tests.sh              # all tests
#   bash run_tests.sh bat          # single classifier
#   bash run_tests.sh bat insect   # two classifiers
#   bash run_tests.sh -v           # verbose (show each test name)
#   bash run_tests.sh -x           # stop on first failure
#   bash run_tests.sh --quick      # skip model-dependent tests

set -euo pipefail
cd "$(dirname "$0")"

VENV=".venv/bin/python3"
if [[ ! -x "$VENV" ]]; then
    echo "ERROR: virtual environment not found — run install.sh first"
    exit 1
fi

# ── Argument parsing ──────────────────────────────────────────────────────────

PYTEST_ARGS=()
CLASSIFIERS=()
QUICK=false

for arg in "$@"; do
    case "$arg" in
        -v|--verbose)   PYTEST_ARGS+=("-v") ;;
        -x|--exitfirst) PYTEST_ARGS+=("-x") ;;
        -q|--quiet)     PYTEST_ARGS+=("-q") ;;
        --quick)        QUICK=true ;;
        -*)             PYTEST_ARGS+=("$arg") ;;
        bat|bee|bird|insect|soil|water|pipeline)
            CLASSIFIERS+=("$arg") ;;
        *)
            echo "Unknown argument: $arg"
            echo "Usage: bash run_tests.sh [bat|bee|bird|insect|soil|water|pipeline] [-v] [-x] [--quick]"
            exit 1 ;;
    esac
done

# ── Select test files ─────────────────────────────────────────────────────────

ALL_TESTS=(
    "tests/test_pipeline.py"
    "tests/test_bat_pipeline.py"
    "tests/test_bee_pipeline.py"
    "tests/test_bird_pipeline.py"
    "tests/test_insect_pipeline.py"
    "tests/test_soil_pipeline.py"
    "tests/test_water_pipeline.py"
)

if [[ ${#CLASSIFIERS[@]} -gt 0 ]]; then
    TARGETS=()
    for c in "${CLASSIFIERS[@]}"; do
        if [[ "$c" == "pipeline" ]]; then
            TARGETS+=("tests/test_pipeline.py")
        else
            TARGETS+=("tests/test_${c}_pipeline.py")
        fi
    done
else
    TARGETS=("${ALL_TESTS[@]}")
fi

# ── Run ───────────────────────────────────────────────────────────────────────

CMD=("$VENV" "-m" "pytest" "${PYTEST_ARGS[@]}" "${TARGETS[@]}")

if [[ "$QUICK" == true ]]; then
    # Skip tests that require a loaded model or real audio clips
    CMD+=("-m" "not slow" "--ignore=tests/test_insect_pipeline.py" "-k" "not real_clip")
    echo "Quick mode — skipping model-dependent tests"
fi

echo ""
echo "BASE test suite — $(date '+%Y-%m-%d %H:%M')"
echo "──────────────────────────────────────────────"
echo "Command: ${CMD[*]}"
echo ""

"${CMD[@]}"
