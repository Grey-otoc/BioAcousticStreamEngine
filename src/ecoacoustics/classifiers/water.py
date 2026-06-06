"""
Water acoustics classifier — Water Acoustic Index (WAI).

Hardware
--------
Designed for a submersible hydrophone connected via a standard audio interface.
The hydrophone picks up:
  • biological activity: fish spawning calls and territorial sounds (100–3 kHz),
    freshwater invertebrates — crayfish, water beetles, snapping (300 Hz – 8 kHz)
  • physical noise: turbulent flow, wave action, rain impact (broadband)
  • anthropogenic noise: boat motors, outboard engines, distant machinery (10–300 Hz)
  • electrical interference: cable-conducted mains hum (50, 100, 150, 200 Hz)

Suitable for freshwater deployments such as lakes, ponds, and slow rivers.
Blenheim Palace context: submerged in the Great Lake.

Water Acoustic Index (WAI)
--------------------------
WAI is a multiplicative three-term score, modelled after the Soil Acoustic
Index v2. All three terms must be high for a high WAI — a single failing
term collapses the score to near zero, making the index robust to false
positives from individual noise artefacts.

  ndwi_01         Normalised Difference Water Index, mapped to [0, 1].
                  NDWI = (P_bio − P_anthro) / (P_bio + P_anthro), where
                    P_anthro = power in 10–200 Hz (boat motors, flow rumble)
                    P_bio    = power in 300–5 000 Hz (fish calls, invertebrates)
                  Answers: does the energy live in the biological band, or is
                  it dominated by low-frequency anthropogenic rumble?

  bio_rms_norm    RMS energy in the biological band (300–5 000 Hz), normalised
                  against ``bio_rms_scale`` (tune to your hydrophone's
                  sensitivity / deployment depth).
                  Answers: is there any signal to score at all?

  aci_01          Acoustic Complexity Index of the bio-band signal, normalised
                  against ``aci_scale``. ACI is high for temporally variable
                  biological calls (fish grunts, choruses, invertebrate clicks);
                  low for steady monotone signals (flow noise, motor drone).
                  Answers: is the signal complex and changing (biology), or
                  repetitive and steady (physical / mechanical noise)?

  WAI = ndwi_01 × bio_rms_norm × aci_01

Failure modes
-------------
  silence              bio_rms ≈ 0         → score 0
  boat motor running   NDWI strongly −ve   → score 0
  steady flow noise    ACI ≈ 0             → score 0
  mains hum only       notched + NDWI −ve  → score 0
  fish chorus, quiet   bio_rms low but NDWI + ACI high → low-moderate score
  active fish chorus   all three terms high → high score

Mains / electrical interference
---------------------------------
A notch cascade at 50, 100, 150, 200 Hz (Q = 30) removes cable-conducted
electrical noise common in hydrophone setups before the power-spectrum split.

Activity levels
---------------
  WAI ≥ 0.60  →  High Water Activity
  WAI ≥ 0.30  →  Moderate Water Activity
  WAI < 0.30  →  Low Water Activity

Beta note
---------
WAI is signal-processing-derived, not data-driven. Treat outputs as
indicative of relative biological activity rather than absolute species counts.
Thresholds and band boundaries should be calibrated against labelled recordings
from each deployment site. Comparisons across different hydrophones or depths
require recalibration of bio_rms_scale.

Author: David Green, Blenheim Palace
Acoustic indices after: Pieretti et al. (2011) ACI; Pijanowski et al. (2011)
NDSI; Staaterman et al. (2014) aquatic soundscape methods.
"""

from typing import Any

import numpy as np
from scipy import signal as scisig

from ecoacoustics.audio.capture import AudioChunk
from ecoacoustics.classifiers.base import BaseClassifier, Detection


class WaterClassifier(BaseClassifier):
    """Water Acoustic Index (WAI) classifier — freshwater hydrophone."""

    name = "water"

    def __init__(self, config: dict[str, Any]):
        """
        Args:
            config: Section from settings.yaml under the 'water' key.

            min_confidence   Minimum WAI to report a detection. Default 0.1.
            bio_rms_scale    RMS in the bio band that maps to a 1.0 contribution.
                             Tune this to your hydrophone's sensitivity and depth.
                             Typical range: 0.001 – 0.05. Default 0.005.
            aci_scale        ACI value that maps to a 1.0 contribution. Tune to
                             the complexity of your background soundscape.
                             Default 0.3.
            anthro_hz        [low, high] of the anthropogenic noise band.
                             Default [10, 200] (boat motors, flow rumble).
            bio_hz           [low, high] of the biological signal band.
                             Default [300, 5000] (fish calls, invertebrates).
            mains_hz         Mains-harmonic centre frequencies to notch out.
                             Default [50, 100, 150, 200] (UK 50 Hz mains).
            mains_q          Notch sharpness (Q factor). Default 30.
            report_cooldown  Seconds between repeated detections at the same
                             activity level. Default 30.
        """
        self._min_confidence: float = config.get("min_confidence", 0.1)
        self._bio_rms_scale: float = float(config.get("bio_rms_scale", 0.005))
        self._aci_scale: float = float(config.get("aci_scale", 0.3))
        self._anthro_hz: tuple[float, float] = tuple(config.get("anthro_hz", [10, 200]))
        self._bio_hz: tuple[float, float] = tuple(config.get("bio_hz", [300, 5000]))
        self._mains_hz: list[float] = list(config.get("mains_hz", [50, 100, 150, 200]))
        self._mains_q: float = float(config.get("mains_q", 30.0))
        self._cooldown: float = float(config.get("report_cooldown", 30.0))

        # Cached filters — built lazily on first chunk
        self._notch_sos: np.ndarray | None = None
        self._notch_sr: int | None = None
        self._bio_sos: np.ndarray | None = None
        self._bio_sos_key: tuple | None = None

    @property
    def sample_rate(self) -> int:
        # 44.1 kHz captures fish (to ~22 kHz Nyquist) and freshwater invertebrates
        return 44100

    @property
    def freq_min_hz(self) -> int:
        return 10

    @property
    def freq_max_hz(self) -> int:
        return 8000

    @property
    def report_cooldown_secs(self) -> float:
        return self._cooldown

    def load(self) -> None:
        pass

    def classify(self, chunk: AudioChunk) -> list[Detection]:
        """Compute WAI from a hydrophone audio chunk and emit one Detection.

        Args:
            chunk: 44.1 kHz audio, 10–8000 Hz bandpass applied by AudioProcessor.

        Returns:
            A single Detection whose confidence IS the WAI, or an empty list
            if below min_confidence.
        """
        audio = chunk.data.astype(np.float64)
        if len(audio) == 0:
            return []

        # Strip mains hum before spectral analysis
        notched = self._apply_mains_notches(audio, chunk.sample_rate)

        # Power spectrum (Welch method — reduced variance vs. single FFT)
        freqs, psd = scisig.welch(
            notched,
            fs=chunk.sample_rate,
            nperseg=min(2048, len(notched)),
        )
        anthro_p = _band_power(freqs, psd, *self._anthro_hz)
        bio_p    = _band_power(freqs, psd, *self._bio_hz)

        # Term 1: Normalised Difference Water Index
        denom = bio_p + anthro_p
        ndwi = float((bio_p - anthro_p) / denom) if denom > 1e-20 else 0.0
        ndwi_01 = (ndwi + 1.0) / 2.0   # map [-1, 1] → [0, 1]

        # Term 2: Bio-band RMS energy
        bio_rms = float(np.sqrt(bio_p)) if bio_p > 0 else 0.0
        bio_rms_norm = min(bio_rms / max(self._bio_rms_scale, 1e-10), 1.0)

        # Term 3: Acoustic Complexity Index on bio-band signal
        bio_signal = self._bio_band_filter(notched, chunk.sample_rate)
        aci = _acoustic_complexity_index(bio_signal)
        aci_01 = min(aci / max(self._aci_scale, 1e-10), 1.0)

        wai = round(ndwi_01 * bio_rms_norm * aci_01, 4)

        if wai < self._min_confidence:
            return []

        if wai >= 0.60:
            level = "High"
        elif wai >= 0.30:
            level = "Moderate"
        else:
            level = "Low"

        return [Detection(
            label=f"Water Activity — {level}",
            confidence=wai,
            classifier=self.name,
            timestamp=chunk.timestamp,
            metadata={
                "wai": wai,
                "ndwi": round(ndwi, 4),
                "bio_band_hz": list(self._bio_hz),
                "anthro_band_hz": list(self._anthro_hz),
                "bio_band_power": float(f"{bio_p:.6e}"),
                "anthro_band_power": float(f"{anthro_p:.6e}"),
                "bio_rms": round(bio_rms, 6),
                "aci": round(aci, 4),
                "activity_level": level,
                "beta": True,
            },
        )]

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _apply_mains_notches(self, audio: np.ndarray, sr: int) -> np.ndarray:
        if self._notch_sos is None or self._notch_sr != sr:
            sections: list[np.ndarray] = []
            nyq = sr / 2.0
            for f0 in self._mains_hz:
                if 0 < f0 < nyq:
                    b, a = scisig.iirnotch(f0, self._mains_q, fs=sr)
                    sections.append(scisig.tf2sos(b, a))
            self._notch_sos = np.vstack(sections) if sections else None
            self._notch_sr = sr
        if self._notch_sos is None:
            return audio
        return scisig.sosfilt(self._notch_sos, audio)

    def _bio_band_filter(self, audio: np.ndarray, sr: int) -> np.ndarray:
        low, high = float(self._bio_hz[0]), float(self._bio_hz[1])
        nyq = sr / 2.0
        if not (0 < low < high < nyq):
            return audio
        key = (sr, low, high)
        if self._bio_sos is None or self._bio_sos_key != key:
            self._bio_sos = scisig.butter(
                5, [low / nyq, high / nyq], btype="band", output="sos",
            )
            self._bio_sos_key = key
        return scisig.sosfilt(self._bio_sos, audio)


# ------------------------------------------------------------------
# Module-level pure functions (shared logic, no state)
# ------------------------------------------------------------------

def _band_power(freqs: np.ndarray, psd: np.ndarray, low: float, high: float) -> float:
    mask = (freqs >= low) & (freqs <= high)
    if not mask.any():
        return 0.0
    integrate = getattr(np, "trapezoid", None) or np.trapz  # type: ignore[attr-defined]
    return float(integrate(psd[mask], freqs[mask]))


def _acoustic_complexity_index(audio: np.ndarray, n_fft: int = 512, hop: int = 256) -> float:
    if len(audio) < n_fft:
        return 0.0
    n_frames = (len(audio) - n_fft) // hop + 1
    if n_frames < 2:
        return 0.0
    spectrogram = np.array([
        np.abs(np.fft.rfft(audio[i * hop: i * hop + n_fft]))
        for i in range(n_frames)
    ])
    diffs = np.abs(np.diff(spectrogram, axis=0))
    sums  = spectrogram[:-1].sum(axis=0) + 1e-10
    return float((diffs.sum(axis=0) / sums).mean())
