#!/usr/bin/env python3
"""
Orthoptera classifier — continue training to 30 epochs total.

Resumes from the best checkpoint saved at epoch 4 (models/orthoptera_checkpoints/best.model)
so we skip ~40h of already-completed work.

Outputs:
  models/orthoptera_checkpoints_v2/   — checkpoint every 5 epochs
  models/orthoptera_uk_v2.model       — final model
  training/train_v2.log               — full log (stdout/stderr redirected here by launch script)
"""

import os, sys, time, datetime
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

DATA_DIR       = os.path.join(ROOT, "training", "data")
MODELS_DIR     = os.path.join(ROOT, "models")
CHECKPOINT_DIR = os.path.join(MODELS_DIR, "orthoptera_checkpoints_v2")
RESUME_FROM    = os.path.join(MODELS_DIR, "orthoptera_checkpoints", "best.model")
FINAL_MODEL    = os.path.join(MODELS_DIR, "orthoptera_uk_v2.model")

os.makedirs(CHECKPOINT_DIR, exist_ok=True)

def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)

log("=" * 60)
log("Orthoptera v2 training — 30 epochs (resuming from epoch 4)")
log("=" * 60)

# ── Load label splits ──────────────────────────────────────────────────────────
log("Loading label splits…")
train = pd.read_csv(os.path.join(DATA_DIR, "train.csv"), index_col=[0, 1, 2])
val   = pd.read_csv(os.path.join(DATA_DIR, "val.csv"),   index_col=[0, 1, 2])
test  = pd.read_csv(os.path.join(DATA_DIR, "test.csv"),  index_col=[0, 1, 2])
log(f"  Train: {len(train):,}  Val: {len(val):,}  Test: {len(test):,}")
log(f"  Classes ({len(train.columns)}): {', '.join(train.columns)}")

# ── Load checkpoint ────────────────────────────────────────────────────────────
log(f"Loading checkpoint: {RESUME_FROM}")
from opensoundscape import CNN
model = CNN.load(RESUME_FROM)
log("Checkpoint loaded OK")

# ── Train 25 more epochs (total = 30) ─────────────────────────────────────────
EXTRA_EPOCHS   = 25
SAVE_INTERVAL  = 5
NUM_WORKERS    = 4   # use all cores for data loading
BATCH_SIZE     = 32

log(f"Starting {EXTRA_EPOCHS} additional epochs "
    f"(checkpoint every {SAVE_INTERVAL}, batch={BATCH_SIZE}, workers={NUM_WORKERS})")
log("Estimated wall time on this CPU: ~7h per epoch = ~7 days total")
log("-" * 60)

t0 = time.time()

model.train(
    train,
    val,
    epochs=EXTRA_EPOCHS,
    batch_size=BATCH_SIZE,
    save_path=CHECKPOINT_DIR,
    save_interval=SAVE_INTERVAL,
    num_workers=NUM_WORKERS,
)

elapsed = time.time() - t0
log(f"Training complete in {elapsed/3600:.1f}h")

# ── Evaluate on held-out test set ─────────────────────────────────────────────
log("Evaluating on test set…")
from sklearn.metrics import classification_report
import numpy as np

scores = model.predict(test, num_workers=NUM_WORKERS)
y_true = test.values
y_pred = (scores.values > 0.5).astype(int)

report = classification_report(
    y_true, y_pred,
    target_names=list(train.columns),
    zero_division=0,
)
log("Test set results:\n" + report)

# ── Threshold sweep ───────────────────────────────────────────────────────────
log("Threshold sweep (macro-F1):")
from sklearn.metrics import f1_score
best_t, best_f1 = 0.5, 0.0
for t in np.arange(0.10, 0.91, 0.05):
    f1 = f1_score(y_true, (scores.values > t).astype(int),
                  average='macro', zero_division=0)
    tag = " ← best" if f1 > best_f1 else ""
    log(f"  threshold={t:.2f}  macro-F1={f1:.3f}{tag}")
    if f1 > best_f1:
        best_f1, best_t = f1, t
log(f"Best threshold: {best_t:.2f}  macro-F1={best_f1:.3f}")

# ── Save final model ──────────────────────────────────────────────────────────
model.save(FINAL_MODEL)
log(f"Model saved: {FINAL_MODEL}")
log("Done. Update config/settings.yaml: insect.model_path = models/orthoptera_uk_v2.model")
log(f"Recommended min_confidence threshold: {best_t:.2f}")
