"""
Train a 4-class struggle classifier (none/low/med/high) on synthetic data
mirroring the extension's StruggleDetector featurize() output layout.

Feature layout (60 dims = 10 signals × 6 stats):
  Signals (SIGNAL_FEATURE_ORDER from struggle-detector.ts):
    SCROLL_VELOCITY, CLICK_ACCURACY, DWELL_TIME, TYPING_RHYTHM,
    BACKSPACE_RATE, ZOOM_EVENTS, CURSOR_PATH, ERROR_RATE,
    READING_SPEED, HESITATION
  Stats per signal (indices 0-5):
    [current, mean, stddev, min, max, trend]
    current/mean/stddev/min/max ∈ [0,1]; trend ∈ [-1,1]
"""

import numpy as np
import onnxmltools
import onnxruntime as rt
from onnxmltools.convert.common.data_types import FloatTensorType
from sklearn.metrics import (classification_report, confusion_matrix,
                             roc_auc_score)
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import label_binarize
from xgboost import XGBClassifier

SEED = 42
N_SAMPLES = 5000
N_SIGNALS = 10
N_STATS = 6          # current, mean, stddev, min, max, trend
N_FEATURES = N_SIGNALS * N_STATS  # 60

# Signal index → column of 'current' stat (every 6th starting at 0)
# SCROLL_VELOCITY=0, CLICK_ACCURACY=1, DWELL_TIME=2, TYPING_RHYTHM=3,
# BACKSPACE_RATE=4, ZOOM_EVENTS=5, CURSOR_PATH=6, ERROR_RATE=7,
# READING_SPEED=8, HESITATION=9
CURRENT_IDX = [i * N_STATS for i in range(N_SIGNALS)]  # [0,6,12,...,54]

# Weighted-sum formula mirrors heuristic scoring:
# Higher struggle driven by low CLICK_ACCURACY, high BACKSPACE_RATE,
# high ERROR_RATE, high HESITATION, high DWELL_TIME.
# 4 highest-impact signals get weight 0.15; others get 0.07.
# Total ≈ 4×0.15 + 6×0.07 = 1.02 → scores land near [0,1].
WEIGHTS = [
    0.07,   # SCROLL_VELOCITY  – weak signal
    0.15,   # CLICK_ACCURACY   – high-impact (low accuracy → high struggle)
    0.15,   # DWELL_TIME       – high-impact
    0.07,   # TYPING_RHYTHM    – weak signal
    0.15,   # BACKSPACE_RATE   – high-impact
    0.07,   # ZOOM_EVENTS      – weak signal
    0.07,   # CURSOR_PATH      – weak signal
    0.15,   # ERROR_RATE       – high-impact
    0.07,   # READING_SPEED    – weak signal
    0.07,   # HESITATION       – (note: included at 0.07; sum kept ≤1)
]

rng = np.random.default_rng(SEED)

# --- Synthetic data generation ---
X = np.zeros((N_SAMPLES, N_FEATURES), dtype=np.float32)
for i in range(N_SIGNALS):
    base = rng.uniform(0, 1, (N_SAMPLES, 5))   # current,mean,stddev,min,max
    trend = rng.uniform(-1, 1, (N_SAMPLES, 1))  # trend ∈ [-1,1]
    X[:, i * N_STATS: i * N_STATS + 5] = base
    X[:, i * N_STATS + 5] = trend[:, 0]

# Weighted sum of 'current' stat for each signal + Gaussian noise (σ=0.05)
# Noise makes the boundary non-trivial so the classifier actually has to learn.
raw = np.sum([WEIGHTS[i] * X[:, CURRENT_IDX[i]] for i in range(N_SIGNALS)], axis=0)
raw += rng.normal(0, 0.05, N_SAMPLES)
raw = np.clip(raw, 0, 1)

# Bin into 4 classes: 0=none, 1=low, 2=med, 3=high
y = np.digitize(raw, bins=[0.25, 0.50, 0.75]).astype(np.int32)

# --- Train / test split ---
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=SEED, stratify=y
)

# --- XGBoost training ---
clf = XGBClassifier(
    objective="multi:softprob",
    num_class=4,
    n_estimators=100,
    max_depth=6,
    learning_rate=0.1,
    eval_metric="mlogloss",
    random_state=SEED,
    use_label_encoder=False,
)
clf.fit(X_train, y_train)

# --- Evaluation ---
y_prob = clf.predict_proba(X_test)
y_bin = label_binarize(y_test, classes=[0, 1, 2, 3])
macro_auc = roc_auc_score(y_bin, y_prob, multi_class="ovr", average="macro")
print(f"\nMacro AUC (OvR): {macro_auc:.4f}")
print("\nConfusion Matrix (rows=true, cols=pred):")
print(confusion_matrix(y_test, clf.predict(X_test)))
print("\nPer-class precision / recall:")
print(classification_report(y_test, clf.predict(X_test),
                             target_names=["none", "low", "med", "high"]))

# --- ONNX export via onnxmltools (handles XGBoost natively) ---
import os
os.makedirs("output", exist_ok=True)

initial_type = [("features", FloatTensorType([None, N_FEATURES]))]
onnx_model = onnxmltools.convert_xgboost(
    clf, initial_types=initial_type, target_opset=13
)
onnx_path = "output/struggle-classifier-v1.onnx"
onnxmltools.utils.save_model(onnx_model, onnx_path)
print(f"\nONNX model saved -> {onnx_path}")

# --- Round-trip verification ---
sess = rt.InferenceSession(onnx_path)
sample = X_test[:1]
out = sess.run(None, {"features": sample})
# onnxmltools XGBoost output: list with [label_array, [{cls: prob, ...}]]
# The probability tensor may be the second element as a list-of-dicts.
if isinstance(out[1], list):
    probs = np.array([[out[1][0][k] for k in sorted(out[1][0].keys())]])
else:
    probs = out[1]
assert probs.shape == (1, 4), f"Unexpected shape: {probs.shape}"
assert abs(probs.sum() - 1.0) < 1e-4, f"Probs don't sum to 1: {probs.sum()}"
print(f"Round-trip OK — sample probs: {probs.round(4)}")
